import { z } from "zod";
import type { MemoryType } from "../types.js";
import { formatLongDate } from "./dates.js";
import { buildVocabulary, checkGrounding, DEFAULT_MIN_GROUNDED_RATIO } from "./grounding.js";
import type { ChatClient } from "./llm.js";
import { MAX_PROMPT_LABEL, sanitizePromptLabel, sanitizePromptText, sanitizeRole } from "./sanitize.js";
import type { ExtractedFact, ExtractionInput, ExtractionTurn, Extractor } from "./types.js";

/**
 * The prompt is the product here. Priority order, and why:
 *
 * 1. Dates. Turns are labelled with their real date INCLUDING the weekday, which
 *    is what makes "last Tuesday" arithmetic possible instead of guessed. mem0
 *    cannot receive a conversation date at all (its timestamp= param raises, and
 *    its prompt hardcodes "Today's date is {now}"), so it mis-dates 11-31% of
 *    memories and still doubles our temporal score purely by writing the date
 *    into the fact text. Doing the same thing with the *correct* anchor is the
 *    whole reason this module exists.
 * 2. Referents, so a retrieved fact answers without its neighbours.
 * 3. Atomicity, so retrieval scores one claim at a time.
 * 4. Filler removal — the "keep" list is written as concrete evidence carriers
 *    (person/place/date/number/plan/...) rather than "keep important things",
 *    because a vague instruction discards evidence.
 * 5. Grounding, restated as a cost asymmetry ("a missing fact is cheap, a wrong
 *    fact is not") since that is the failure this repo has actually shipped.
 */
const SYSTEM_PROMPT = `You convert raw conversation turns into standalone memory facts for a long-term memory store.

Each fact must be understandable years from now by a reader who cannot see the conversation.

RULES
1. DATES. Every turn is labelled with the real date it was written, including the weekday. Resolve EVERY relative time expression ("yesterday", "last Tuesday", "two weeks ago", "next month", "this morning") against that turn's own date, and write the resolved absolute date into the fact text: "on 8 May 2025", "in May 2025", "in 2025" - use the most precise form the turn supports. Copy explicit dates as stated. If a turn is marked "date not recorded", do NOT invent a date: keep the original wording.
2. REFERENTS. No pronouns or deictics in a fact. Replace I/me/my/you/he/she/they/it/there/that with the concrete name or noun used in the conversation. "I" is the ACTOR named below. If the referent is not recoverable from the turns shown, drop the fact.
3. ONE CLAIM PER FACT. Split compound turns. Each fact repeats whatever context it needs (who, when, where) to stand alone.
4. KEEP vs DROP. Keep any turn carrying a person, place, organisation, date, number, plan, decision, preference, possession, relationship, health detail, work detail, purchase, or event. Drop greetings, thanks, acknowledgements ("ok", "sounds good"), pure emotional reactions with no content, and questions that assert nothing.
5. NEVER INVENT. Every name, number, place, and claim must appear in the turns shown. Do not answer questions, do not infer motives, do not connect facts the turns do not connect, do not guess. A missing fact is cheap; a wrong fact is not.
6. PROVENANCE. Attribute each fact to the numbered turn(s) it came from.

TYPES: fact, preference, goal, project, episode, tool_outcome, instruction, profile, pattern, summary.

Reply with JSON only, in this exact shape:
{"facts":[{"text":"<self-contained dated fact>","type":"fact","turns":[0],"importance":0.5,"confidence":0.9}]}
If nothing in the turns is worth remembering, reply {"facts":[]}.`;

const MEMORY_TYPES: readonly MemoryType[] = [
  "fact", "preference", "goal", "project", "episode",
  "tool_outcome", "instruction", "profile", "pattern", "summary",
];

const TYPE_ALIASES: Record<string, MemoryType> = {
  event: "episode",
  experience: "episode",
  memory: "episode",
  personal_info: "profile",
  personal: "profile",
  identity: "profile",
  bio: "profile",
  task: "project",
  plan: "goal",
  intent: "goal",
  habit: "pattern",
  routine: "pattern",
  rule: "instruction",
  note: "fact",
  knowledge: "fact",
  opinion: "preference",
  like: "preference",
  dislike: "preference",
};

function coerceMemoryType(raw: string | null | undefined, fallback: MemoryType): MemoryType {
  if (!raw) return fallback;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((MEMORY_TYPES as readonly string[]).includes(key)) return key as MemoryType;
  return TYPE_ALIASES[key] ?? fallback;
}

const rawFactSchema = z
  .object({
    text: z.string(),
    type: z.string().nullish(),
    memoryType: z.string().nullish(),
    turns: z.array(z.union([z.number(), z.string()])).nullish(),
    sourceTurnIndexes: z.array(z.union([z.number(), z.string()])).nullish(),
    importance: z.union([z.number(), z.string()]).nullish(),
    confidence: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

// Unknown keys are stripped (zod default) so the narrowing below stays typed.
const payloadSchema = z.union([
  z.object({ facts: z.array(rawFactSchema) }),
  z.object({ memories: z.array(rawFactSchema) }),
  z.array(rawFactSchema),
]);

export type RawFact = z.infer<typeof rawFactSchema>;

function toNumber(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(Math.max(parsed, 0), 1);
}

function toIndexes(value: Array<number | string> | null | undefined): number[] {
  if (!value) return [];
  const out: number[] = [];
  for (const entry of value) {
    const parsed = typeof entry === "number" ? entry : Number(String(entry).replace(/[^\d-]/g, ""));
    if (Number.isInteger(parsed)) out.push(parsed);
  }
  return out;
}

export type FactsPayloadStatus = "ok" | "empty" | "unparsable" | "ambiguous";

export interface FactsPayloadResult {
  status: FactsPayloadStatus;
  facts: RawFact[];
}

function readPayloadFacts(payload: z.infer<typeof payloadSchema>): RawFact[] {
  if (Array.isArray(payload)) return payload;
  if ("facts" in payload) return payload.facts;
  if ("memories" in payload) return payload.memories;
  return [];
}

/**
 * Pulls the JSON payload out of a completion. Scans for balanced top-level
 * `{...}` / `[...]` spans and requires exactly ONE distinct non-empty payload.
 *
 * Neither "first wins" nor "last wins" is safe here. An injected turn can get a
 * second object appended after the legitimate answer (last wins hands the store
 * to the attacker) or prepended before it (first wins does the same), and there
 * is no way to tell from the text which object the model meant. So ambiguity is
 * treated as a failed batch: the caller keeps the raw turns, marked as
 * unextracted, and the event is counted. JSON mode returns one span anyway, and a
 * reasoning trace's empty `{"facts":[]}` draft is not a competing answer.
 */
export function readFactsPayload(text: string): FactsPayloadResult {
  const payloads: RawFact[][] = [];
  const seen = new Set<string>();
  let sawValidPayload = false;

  for (const candidate of collectJsonSpans(text)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    const parsed = payloadSchema.safeParse(value);
    if (!parsed.success) continue;
    sawValidPayload = true;
    const facts = readPayloadFacts(parsed.data);
    if (facts.length === 0) continue;
    // The same answer emitted twice is repetition, not ambiguity.
    const key = JSON.stringify(facts);
    if (seen.has(key)) continue;
    seen.add(key);
    payloads.push(facts);
  }

  if (payloads.length === 1) return { status: "ok", facts: payloads[0] };
  if (payloads.length > 1) return { status: "ambiguous", facts: [] };
  return sawValidPayload ? { status: "empty", facts: [] } : { status: "unparsable", facts: [] };
}

/** Facts, or null when the completion held no single usable payload. */
export function parseFactsPayload(text: string): RawFact[] | null {
  const result = readFactsPayload(text);
  return result.status === "ok" || result.status === "empty" ? result.facts : null;
}

function collectJsonSpans(text: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const char = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === open) depth++;
      else if (char === close) {
        depth--;
        if (depth === 0) {
          spans.push(text.slice(i, j + 1));
          i = j; // Top-level spans only; nested objects are covered by the parent.
          break;
        }
      }
    }
  }
  return spans;
}

export interface LlmExtractorOptions {
  client: ChatClient;
  /** Turns per LLM call. Default 16. */
  batchSize?: number;
  /** Preceding turns shown read-only so referents resolve across batch seams. */
  contextTurns?: number;
  /** Grounding threshold; see grounding.ts. */
  minGroundedRatio?: number;
  /**
   * What to do with a batch whose call failed or whose response was unusable.
   * "passthrough" (default) emits the raw turns so no memory is ever lost to an
   * LLM failure; "drop" emits nothing. Passthrough facts carry
   * `origin: "fallback"` — they are raw, ungrounded turn text, not extracted
   * facts, and a consumer must be able to tell them apart.
   */
  failureMode?: "passthrough" | "drop";
  /** Hard cap on facts per batch, so one bad response cannot flood the store. */
  maxFactsPerBatch?: number;
  temperature?: number;
  maxTokens?: number;
  logger?: (event: ExtractionLogEvent) => void;
}

export interface ExtractionLogEvent {
  kind:
    | "batch_failed"
    | "unparsable_response"
    | "ambiguous_response"
    | "fact_rejected"
    | "provenance_clipped";
  detail: string;
}

export interface LlmExtractorStats {
  batches: number;
  batchFailures: number;
  turnsSeen: number;
  turnsPassedThrough: number;
  factsEmitted: number;
  factsRejectedUngrounded: number;
  factsRejectedNoProvenance: number;
  /** Facts that cited turns outside their own batch; those indexes were dropped. */
  factsProvenanceClipped: number;
  /** Responses holding more than one candidate payload, so none could be trusted. */
  ambiguousResponses: number;
  promptChars: number;
  completionChars: number;
}

/**
 * Batched, grounded LLM extractor.
 *
 * Cost shape vs mem0, which sends one call per turn and re-sends its prompt each
 * time: at the default batch of 16 this is 1/16th of the calls, and the system
 * prompt is amortized across 16 turns instead of paid 16 times.
 */
export class LlmExtractor implements Extractor {
  readonly id: string;
  readonly stats: LlmExtractorStats = {
    batches: 0,
    batchFailures: 0,
    turnsSeen: 0,
    turnsPassedThrough: 0,
    factsEmitted: 0,
    factsRejectedUngrounded: 0,
    factsRejectedNoProvenance: 0,
    factsProvenanceClipped: 0,
    ambiguousResponses: 0,
    promptChars: 0,
    completionChars: 0,
  };

  private readonly client: ChatClient;
  private readonly batchSize: number;
  private readonly contextTurns: number;
  private readonly minGroundedRatio: number;
  private readonly failureMode: "passthrough" | "drop";
  private readonly maxFactsPerBatch: number;
  private readonly temperature?: number;
  private readonly maxTokens?: number;
  private readonly logger?: (event: ExtractionLogEvent) => void;

  constructor(options: LlmExtractorOptions) {
    this.client = options.client;
    this.batchSize = Math.max(1, options.batchSize ?? 16);
    this.contextTurns = Math.max(0, options.contextTurns ?? 4);
    this.minGroundedRatio = options.minGroundedRatio ?? DEFAULT_MIN_GROUNDED_RATIO;
    this.failureMode = options.failureMode ?? "passthrough";
    this.maxFactsPerBatch = options.maxFactsPerBatch ?? this.batchSize * 4;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.logger = options.logger;
    this.id = `llm:${options.client.id}`;
  }

  async extract(input: ExtractionInput): Promise<ExtractedFact[]> {
    if (input.turns.length === 0) return [];
    this.stats.turnsSeen += input.turns.length;

    const facts: ExtractedFact[] = [];

    for (let start = 0; start < input.turns.length; start += this.batchSize) {
      const end = Math.min(start + this.batchSize, input.turns.length);
      this.stats.batches += 1;
      let batchFacts: ExtractedFact[] | null = null;

      try {
        batchFacts = await this.extractBatch(input, start, end);
      } catch (error) {
        this.stats.batchFailures += 1;
        this.logger?.({ kind: "batch_failed", detail: describeError(error) });
        batchFacts = null;
      }

      if (batchFacts === null) {
        // A failed batch must not silently swallow its turns. The text is raw and
        // has been through neither gate, so it is marked "fallback" rather than
        // passed off as an extracted fact.
        if (this.failureMode === "passthrough") {
          for (let i = start; i < end; i++) {
            facts.push({
              text: input.turns[i].text,
              memoryType: "fact",
              sourceTurnIndexes: [i],
              origin: "fallback",
            });
            this.stats.turnsPassedThrough += 1;
          }
        }
        continue;
      }
      facts.push(...batchFacts);
    }

    this.stats.factsEmitted += facts.length;
    return facts;
  }

  /** Turns the model is shown for a batch: its own turns plus the read-only lookback. */
  private visibleWindow(start: number, end: number): { contextStart: number; end: number } {
    return { contextStart: Math.max(0, start - this.contextTurns), end };
  }

  private async extractBatch(
    input: ExtractionInput,
    start: number,
    end: number,
  ): Promise<ExtractedFact[] | null> {
    const visible = this.visibleWindow(start, end);
    // Per batch, not per input: a fact may only be grounded in what its own batch
    // was shown, or a claim recombining turn 2 with turn 40 scores as faithful.
    const vocabulary = buildVocabulary(input, { start: visible.contextStart, end: visible.end });
    const prompt = this.buildUserPrompt(input, start, end);
    this.stats.promptChars += SYSTEM_PROMPT.length + prompt.length;

    const completion = await this.client.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      json: true,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });
    this.stats.completionChars += completion.content.length;

    const payload = readFactsPayload(completion.content);
    if (payload.status === "ambiguous") {
      this.stats.batchFailures += 1;
      this.stats.ambiguousResponses += 1;
      this.logger?.({ kind: "ambiguous_response", detail: completion.content.slice(0, 200) });
      return null;
    }
    if (payload.status === "unparsable") {
      this.stats.batchFailures += 1;
      this.logger?.({ kind: "unparsable_response", detail: completion.content.slice(0, 200) });
      return null;
    }

    const out: ExtractedFact[] = [];
    for (const candidate of payload.facts.slice(0, this.maxFactsPerBatch)) {
      const fact = this.validateFact(candidate, input, start, end, vocabulary);
      if (fact) out.push(fact);
    }
    return out;
  }

  private validateFact(
    raw: RawFact,
    input: ExtractionInput,
    start: number,
    end: number,
    vocabulary: Set<string>,
  ): ExtractedFact | null {
    const text = String(raw.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 8) return null;

    // Provenance is scoped to the batch's own extractable turns. Read-only context
    // turns are NOT permissible: the prompt forbids extracting from them, and
    // service.ts derives the stored record's date and source from min(indexes), so
    // an earlier-batch index would re-date and mis-attribute the memory. Indexes
    // outside the window are dropped rather than merged, and at least one must
    // survive — an unattributable memory is worse than a missing one.
    const claimed = toIndexes(raw.turns ?? raw.sourceTurnIndexes);
    let indexes = claimed.filter((index) => index >= start && index < end);
    if (indexes.length < claimed.length) {
      this.stats.factsProvenanceClipped += 1;
      this.logger?.({
        kind: "provenance_clipped",
        detail: `claimed [${claimed.join(",")}] outside turns ${start}-${end - 1}: ${text.slice(0, 120)}`,
      });
    }
    // A single-turn batch is unambiguous, so a missing attribution is recoverable.
    if (indexes.length === 0 && end - start === 1) indexes = [start];
    if (indexes.length === 0) {
      this.stats.factsRejectedNoProvenance += 1;
      this.logger?.({ kind: "fact_rejected", detail: `no provenance: ${text.slice(0, 120)}` });
      return null;
    }

    const grounding = checkGrounding(text, vocabulary, { minRatio: this.minGroundedRatio });
    if (!grounding.grounded) {
      this.stats.factsRejectedUngrounded += 1;
      this.logger?.({
        kind: "fact_rejected",
        detail: `ungrounded (${grounding.ratio.toFixed(2)}, novel: ${grounding.novel.slice(0, 6).join(",")}): ${text.slice(0, 120)}`,
      });
      return null;
    }

    return {
      text,
      memoryType: coerceMemoryType(raw.type ?? raw.memoryType, "fact"),
      importance: toNumber(raw.importance),
      confidence: toNumber(raw.confidence),
      sourceTurnIndexes: [...new Set(indexes)].sort((a, b) => a - b),
      origin: "extracted",
    };
  }

  /**
   * Renders the batch, plus a read-only lookback so referents survive the seam.
   * Every untrusted value here — actor, conversation, role, turn text — goes
   * through sanitize.ts, so nothing user-authored can start a line and forge a
   * turn block. Only the prompt is sanitized; stored text is untouched.
   */
  private buildUserPrompt(input: ExtractionInput, start: number, end: number): string {
    const lines: string[] = [];
    // Quoted so an injected display name reads as one value, not as more prompt.
    const actor = input.actor ? sanitizePromptLabel(input.actor) : "";
    const context = input.context ? sanitizePromptLabel(input.context, MAX_PROMPT_LABEL) : "";
    lines.push(`ACTOR ("I" refers to this person): "${actor || "the user"}"`);
    if (context) lines.push(`CONVERSATION: "${context}"`);
    lines.push(`CURRENT DATE: ${formatLongDate(input.now) ?? "unknown"}`);
    lines.push("");

    const { contextStart } = this.visibleWindow(start, end);
    if (contextStart < start) {
      lines.push("EARLIER TURNS (context only - resolve referents from these, do NOT extract facts from them):");
      for (let i = contextStart; i < start; i++) lines.push(this.renderTurn(input.turns[i], i));
      lines.push("");
    }

    lines.push("TURNS TO EXTRACT:");
    for (let i = start; i < end; i++) lines.push(this.renderTurn(input.turns[i], i));
    lines.push("");
    lines.push(`Extract facts from turns ${start}-${end - 1} only. JSON only.`);
    return lines.join("\n");
  }

  private renderTurn(turn: ExtractionTurn, index: number): string {
    const sanitizedRole = turn.role ? sanitizeRole(turn.role) : "";
    const role = sanitizedRole ? ` (${sanitizedRole})` : "";
    const date = formatLongDate(turn.at) ?? "date not recorded";
    return `[${index}]${role} ${date}: ${sanitizePromptText(turn.text)}`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export { SYSTEM_PROMPT as EXTRACTION_SYSTEM_PROMPT };
