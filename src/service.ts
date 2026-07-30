import type { ExtractedFact, ExtractionTurn, Extractor } from "./extraction/types.js";
import type { MemoryProvider } from "./provider.js";
import type {
  MemoryCompactResult,
  ContextBuildRequest,
  ContextBuildResult,
  DecayPolicy,
  MemoryFeedbackInput,
  MemoryIngestRequest,
  MemoryObservation,
  MemoryProfile,
  MemoryRecord,
  MemoryScope,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryType,
} from "./types.js";
import { clamp, normalizeText, uid } from "./utils.js";

const DEFAULT_DECAY: DecayPolicy = { kind: "time", ttlDays: 180 };
const DEFAULT_SCOPE: MemoryScope = "actor";
const DEFAULT_CONFIDENCE = 0.7;
const DEFAULT_IMPORTANCE = 0.5;
const MAX_TEXT_LEN = 1000;

function summarizeText(text: string): string {
  const clean = normalizeText(text);
  if (clean.length <= 120) return clean;
  return `${clean.slice(0, 117)}...`;
}

function normalizeMemoryType(type: MemoryType): MemoryType {
  return type;
}

function normalizeRecord(record: MemoryRecord): MemoryRecord {
  const now = new Date().toISOString();
  const text = normalizeText(record.text).slice(0, MAX_TEXT_LEN);

  return {
    ...record,
    text,
    summary: record.summary ? normalizeText(record.summary).slice(0, 200) : summarizeText(text),
    confidence: clamp(record.confidence, 0, 1),
    importance: clamp(record.importance, 0, 1),
    metadata: record.metadata || {},
    firstSeenAt: record.firstSeenAt || now,
    lastSeenAt: record.lastSeenAt || now,
    createdAt: record.createdAt || now,
    updatedAt: record.updatedAt || now,
    decayPolicy: record.decayPolicy || DEFAULT_DECAY,
  };
}

// Every MemoryType gets a bucket, so callers can index byType without a presence check.
function emptyByType(): Record<MemoryType, string[]> {
  return {
    fact: [],
    preference: [],
    goal: [],
    project: [],
    episode: [],
    tool_outcome: [],
    instruction: [],
    profile: [],
    pattern: [],
    summary: [],
  };
}

function buildProfileSummary(byType: Record<MemoryType, string[]>): string {
  const ordered: Array<[MemoryType, string]> = [
    ["preference", "Preferences"],
    ["goal", "Goals"],
    ["project", "Projects"],
    ["fact", "Facts"],
    ["instruction", "Instructions"],
    ["profile", "Profile"],
    ["pattern", "Patterns"],
    ["summary", "Summaries"],
    ["tool_outcome", "Tool Outcomes"],
    ["episode", "Episodes"],
  ];

  const lines: string[] = [];
  for (const [type, title] of ordered) {
    const items = byType[type] || [];
    if (items.length === 0) continue;
    lines.push(`${title}:`);
    for (const item of items.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export interface MemoryCoreServiceOptions {
  /**
   * Rewrites raw observations into self-contained facts before dedupe and
   * storage. Omitted (or the passthrough) leaves the write path unchanged.
   */
  extractor?: Extractor | null;
  /**
   * What to do with an extraction window that produced no facts. "raw" (default)
   * stores the original observations — an extractor that fails, or judges an
   * exchange to be filler, can then never delete a memory. "drop" trusts the
   * extractor's judgement instead, which raises distillation at the risk of
   * discarding evidence; only set it when you are measuring retention.
   */
  extractionFallback?: "raw" | "drop";
  /**
   * Let unverified (origin="fallback") text into assembled prompt context.
   * Default false. See the guard in buildContext for why.
   */
  includeUnverified?: boolean;
}

function turnRole(obs: MemoryObservation): string | undefined {
  const fromSource = obs.source?.metadata?.role;
  if (typeof fromSource === "string" && fromSource) return fromSource;
  const fromMetadata = obs.metadata?.role;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : undefined;
}

/**
 * Observations only share an extraction window if they share a speaker context.
 * Mixing actors in one window would let "I" resolve to the wrong person, which
 * is exactly the failure extraction exists to prevent.
 */
function extractionGroupKey(obs: MemoryObservation): string {
  return JSON.stringify([obs.tenantId, obs.appId, obs.actorId, obs.threadId ?? null]);
}

/**
 * A record whose text was stored raw because extraction was attempted and
 * failed. It has been through neither the grounding nor the provenance gate.
 */
function isUnverified(record: MemoryRecord): boolean {
  return record.source?.metadata?.extractionOrigin === "fallback";
}

export class MemoryCoreService {
  private readonly extractor?: Extractor;
  private readonly extractionFallback: "raw" | "drop";
  private readonly includeUnverified: boolean;

  constructor(
    private readonly provider: MemoryProvider,
    options: MemoryCoreServiceOptions = {},
  ) {
    this.extractor = options.extractor ?? undefined;
    this.extractionFallback = options.extractionFallback ?? "raw";
    this.includeUnverified = options.includeUnverified ?? false;
  }

  async getHealth() {
    if (!this.provider.health) {
      return {
        ok: true,
        provider: "unknown",
      };
    }
    return this.provider.health();
  }

  async ingest(input: MemoryIngestRequest): Promise<{ created: number; updated: number; records: MemoryRecord[] }> {
    const created: MemoryRecord[] = [];
    const updated: MemoryRecord[] = [];

    // Extraction runs before dedupe so extracted facts dedupe like any other write.
    const observations = this.extractor
      ? await this.extractObservations(input.observations)
      : input.observations;

    for (const obs of observations) {
      // Event time and bookkeeping time are different things. `observedAt` is when
      // the thing happened; decay and recency read `lastSeenAt`, which is when the
      // store last touched the memory. Conflating them made any historical import
      // expire on arrival: a 2023 observation under the default 180-day TTL was
      // already stale, so ingest returned created=1 for a record that getById,
      // search, listByActor and getProfile all refused to return.
      const ingestedAt = new Date().toISOString();
      const observedAt = obs.observedAt || ingestedAt;
      const candidate = normalizeRecord({
        id: uid("mem"),
        tenantId: obs.tenantId,
        appId: obs.appId,
        actorId: obs.actorId,
        threadId: obs.threadId || null,
        scope: obs.scope || DEFAULT_SCOPE,
        memoryType: normalizeMemoryType(obs.memoryType),
        text: obs.text,
        summary: obs.summary || null,
        metadata: obs.metadata || {},
        confidence: obs.confidence ?? DEFAULT_CONFIDENCE,
        importance: obs.importance ?? DEFAULT_IMPORTANCE,
        status: "active",
        source: obs.source,
        decayPolicy: obs.decayPolicy || DEFAULT_DECAY,
        // firstSeenAt keeps the event time so temporal reasoning still has it.
        firstSeenAt: observedAt,
        lastSeenAt: ingestedAt,
        createdAt: ingestedAt,
        updatedAt: ingestedAt,
        stats: {
          selectedCount: 0,
          positiveCount: 0,
          negativeCount: 0,
        },
      });

      const duplicate = await this.provider.findDuplicate(candidate);
      if (duplicate) {
        // Re-observing a memory reinforces it, so its decay window restarts.
        duplicate.lastSeenAt = ingestedAt;
        duplicate.updatedAt = ingestedAt;
        duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
        duplicate.importance = Math.max(duplicate.importance, candidate.importance);
        duplicate.summary = duplicate.summary || candidate.summary;
        duplicate.metadata = { ...duplicate.metadata, ...candidate.metadata };
        updated.push(await this.provider.update(normalizeRecord(duplicate)));
        continue;
      }

      const [saved] = await this.provider.ingest([candidate]);
      created.push(saved);
    }

    return {
      created: created.length,
      updated: updated.length,
      records: [...created, ...updated],
    };
  }

  /**
   * Rewrites a batch of observations into extracted facts, one extraction window
   * per (tenant, app, actor, thread).
   *
   * Two invariants, both paid for in production incidents:
   * - Nothing is lost. If a window throws, or yields no facts, its ORIGINAL
   *   observations are stored unchanged. An LLM outage must not delete memories.
   * - Order is preserved. Derived observations are re-sorted by the index of the
   *   observation they came from, so the returned records keep request order
   *   even though extraction groups by actor.
   */
  private async extractObservations(observations: MemoryObservation[]): Promise<MemoryObservation[]> {
    const extractor = this.extractor;
    if (!extractor || observations.length === 0) return observations;

    const groups = new Map<string, number[]>();
    for (let i = 0; i < observations.length; i++) {
      const key = extractionGroupKey(observations[i]);
      const bucket = groups.get(key);
      if (bucket) bucket.push(i);
      else groups.set(key, [i]);
    }

    const now = new Date().toISOString();
    const ordered: Array<{ index: number; observation: MemoryObservation }> = [];

    for (const indexes of groups.values()) {
      const first = observations[indexes[0]];
      const turns: ExtractionTurn[] = indexes.map((index) => ({
        role: turnRole(observations[index]),
        text: observations[index].text,
        at: observations[index].observedAt,
      }));

      let facts: ExtractedFact[] = [];
      try {
        facts = await extractor.extract({
          turns,
          now,
          actor: first.actorId,
          context: first.threadId || undefined,
        });
      } catch {
        facts = [];
      }

      const derived: Array<{ index: number; observation: MemoryObservation }> = [];
      for (const fact of facts) {
        const local = fact.sourceTurnIndexes.filter((i) => Number.isInteger(i) && i >= 0 && i < indexes.length);
        if (local.length === 0) continue;
        const base = Math.min(...local);
        const baseIndex = indexes[base];
        const baseObservation = observations[baseIndex];

        // A fact identical to its single source turn carries nothing new, so the
        // original observation is stored as-is. Origin still has to be recorded:
        // "passthrough" means no extraction was configured and the text is raw by
        // design (byte-identical to the pre-extraction path, so no marker at all),
        // while "fallback" means extraction was attempted and FAILED, and the raw
        // text is unverified. Those two must never be indistinguishable downstream.
        if (local.length === 1 && fact.text === baseObservation.text) {
          if (fact.origin !== "fallback") {
            derived.push({ index: baseIndex, observation: baseObservation });
            continue;
          }
          derived.push({
            index: baseIndex,
            observation: {
              ...baseObservation,
              source: {
                ...baseObservation.source,
                metadata: {
                  ...baseObservation.source.metadata,
                  extractor: extractor.id,
                  extractionOrigin: fact.origin,
                },
              },
            },
          });
          continue;
        }

        const sourceTurnIndexes = [...new Set(local.map((i) => indexes[i]))].sort((a, b) => a - b);
        derived.push({
          index: baseIndex,
          observation: {
            ...baseObservation,
            text: fact.text,
            // The base summary described the raw turn; let the store re-derive one.
            summary: undefined,
            memoryType: fact.memoryType || baseObservation.memoryType,
            confidence: fact.confidence ?? baseObservation.confidence,
            importance: fact.importance ?? baseObservation.importance,
            source: {
              ...baseObservation.source,
              metadata: {
                ...baseObservation.source.metadata,
                extractor: extractor.id,
                extractionOrigin: fact.origin,
                sourceTurnIndexes,
              },
            },
          },
        });
      }

      // Empty window => extraction failed or found nothing usable; keep the raw turns.
      if (derived.length === 0 && this.extractionFallback === "raw") {
        for (const index of indexes) ordered.push({ index, observation: observations[index] });
      } else {
        ordered.push(...derived);
      }
    }

    ordered.sort((a, b) => a.index - b.index);
    return ordered.map((entry) => entry.observation);
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    return this.provider.search(query);
  }

  private profileFrom(
    records: MemoryRecord[],
    tenantId: string,
    appId: string,
    actorId: string,
  ): MemoryProfile {
    const byType = emptyByType();

    for (const record of records) {
      // Tolerate a provider returning a type outside the union rather than throwing.
      (byType[record.memoryType] ??= []).push(record.text);
    }

    return {
      tenantId,
      appId,
      actorId,
      byType,
      summary: buildProfileSummary(byType),
      count: records.length,
    };
  }

  /** Operator-facing: returns everything, verified or not. */
  async getProfile(tenantId: string, appId: string, actorId: string): Promise<MemoryProfile> {
    return this.profileFrom(await this.provider.listByActor(tenantId, appId, actorId), tenantId, appId, actorId);
  }

  /** Prompt-facing: drops records extraction never grounded. */
  private async actorRecordsForPrompt(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    const records = await this.provider.listByActor(tenantId, appId, actorId);
    return this.includeUnverified ? records : records.filter((record) => !isUnverified(record));
  }

  async buildContext(request: ContextBuildRequest): Promise<ContextBuildResult> {
    // performance.now() so sub-millisecond builds report a real duration.
    const startedAt = performance.now();
    const maxItems = Math.min(Math.max(request.budget?.maxItems ?? 8, 1), 30);
    const maxChars = Math.min(Math.max(request.budget?.maxChars ?? 3000, 300), 20000);
    const hits = await this.search({
      query: request.query,
      filters: request.filters,
      limit: maxItems * 2,
    });

    const selected: ContextBuildResult["selectedMemories"] = [];
    let chars = 0;

    for (const hit of hits) {
      // Unverified text must not reach an assembled prompt. An attacker can force
      // the fallback path on purpose — a turn crafted to make the model return an
      // ambiguous or unparsable response fails the batch, and the raw turn is then
      // stored verbatim — and buildContext output is spliced straight into another
      // agent's prompt. search() and getProfile() still return these records, so
      // nothing is hidden from an operator; only prompt assembly filters.
      if (!this.includeUnverified && isUnverified(hit.memory)) continue;
      if (selected.length >= maxItems) break;
      const line = `- [${hit.memory.memoryType}] ${hit.memory.summary || hit.memory.text}`;
      if (chars + line.length > maxChars) break;
      chars += line.length;
      selected.push({
        id: hit.memory.id,
        memoryType: hit.memory.memoryType,
        text: hit.memory.text,
        score: hit.score,
        reasons: hit.reasons,
      });
    }

    // The profile block is the SECOND path into the prompt, and filtering only the
    // hits above left it wide open: buildProfileSummary reads every record for the
    // actor, so unverified text still landed in contextText under KNOWN ACTOR
    // PROFILE even with zero selectedMemories. Both paths have to be filtered.
    const actorId = request.filters.actorId || "";
    const profile = actorId
      ? this.profileFrom(
          await this.actorRecordsForPrompt(request.filters.tenantId, request.filters.appId, actorId),
          request.filters.tenantId,
          request.filters.appId,
          actorId,
        )
      : {
          tenantId: request.filters.tenantId,
          appId: request.filters.appId,
          actorId: "",
          byType: emptyByType(),
          summary: "",
          count: 0,
        };

    const lines: string[] = [];
    if (profile.summary) {
      lines.push("KNOWN ACTOR PROFILE:");
      lines.push(profile.summary);
      lines.push("");
    }

    if (selected.length > 0) {
      lines.push("RELEVANT MEMORIES:");
      for (const item of selected) {
        lines.push(`- [${item.memoryType}] ${summarizeText(item.text)}`);
      }
    }

    return {
      profileSummary: profile.summary,
      selectedMemories: selected,
      contextText: lines.join("\n").trim(),
      totalMemories: selected.length,
      processingTime: Math.round((performance.now() - startedAt) * 1000) / 1000,
    };
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<{ updated: boolean }> {
    const updated = await this.provider.applyFeedback(feedback);
    return { updated: !!updated };
  }

  async compact(): Promise<MemoryCompactResult> {
    return this.provider.compact();
  }
}
