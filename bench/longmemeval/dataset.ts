import fs from "node:fs";
import path from "node:path";
import { requirePrepared, SPLIT_DIR } from "./paths.js";
import type { MaterializedMemory } from "../types.js";

export interface LmeTurn {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids?: string[];
}

/**
 * "2023/04/10 (Mon) 17:50" -> ISO. The weekday is decorative; time is optional.
 * Parsed as UTC so the same file yields the same timestamps on any box.
 * Throws on an unparseable date: a silent epoch-0 fallback would hand every
 * memory the same timestamp and quietly change recency-sensitive ranking.
 */
export function parseLmeDate(raw: string): string {
  const m = /^\s*(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[^\d]*(\d{1,2}):(\d{2}))?/.exec(raw ?? "");
  if (!m) throw new Error(`unparseable LongMemEval date: ${JSON.stringify(raw)}`);
  const [, y, mo, d, hh, mm] = m;
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}T${(hh ?? "00").padStart(2, "0")}:${mm ?? "00"}:00.000Z`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new Error(`invalid LongMemEval date: ${JSON.stringify(raw)}`);
  return new Date(t).toISOString();
}

export interface CorpusTurn {
  id: string;
  sessionId: string;
  sessionIndex: number;
  turnIndex: number;
  role: string;
  content: string;
  dateRaw: string;
  dateIso: string;
  isGold: boolean;
  /** Exactly what every system indexes. Identical string for all systems. */
  text: string;
}

export interface Corpus {
  questionId: string;
  questionType: string;
  question: string;
  answer: string;
  questionDate: string;
  turns: CorpusTurn[];
  goldIds: string[];
  byId: Map<string, CorpusTurn>;
}

/**
 * One corpus per question. Ids are question-local, which is fine because a
 * corpus is never shared between questions.
 *
 * Neutrality rules (these matter for integrity):
 *  - indexed text is `role: content` and nothing else. No date, no gold flag,
 *    no session id -> no label can reach a ranker through the text channel.
 *  - confidence/importance/memoryType are constant across every turn, so the
 *    provider's quality term is a constant factor and cannot encode a label.
 */
export function buildCorpus(item: LmeQuestion): Corpus {
  const turns: CorpusTurn[] = [];
  const goldIds: string[] = [];

  item.haystack_sessions.forEach((session, si) => {
    const dateRaw = item.haystack_dates[si] ?? item.haystack_dates[item.haystack_dates.length - 1] ?? item.question_date;
    const dateIso = parseLmeDate(dateRaw);
    const sessionId = item.haystack_session_ids[si] ?? `session_${si}`;
    session.forEach((turn, ti) => {
      const id = `s${si}_t${ti}`;
      const isGold = turn.has_answer === true;
      const ct: CorpusTurn = {
        id,
        sessionId,
        sessionIndex: si,
        turnIndex: ti,
        role: turn.role,
        content: turn.content ?? "",
        dateRaw,
        dateIso,
        isGold,
        text: `${turn.role}: ${turn.content ?? ""}`,
      };
      turns.push(ct);
      if (isGold) goldIds.push(id);
    });
  });

  return {
    questionId: item.question_id,
    questionType: item.question_type,
    question: item.question,
    answer: item.answer,
    questionDate: item.question_date,
    turns,
    goldIds,
    byId: new Map(turns.map((t) => [t.id, t])),
  };
}

const UNIFORM_CONFIDENCE = 0.8;
const UNIFORM_IMPORTANCE = 0.5;

/** Corpus -> the repo harness's MaterializedMemory, so repo systems run unmodified. */
export function toMaterialized(corpus: Corpus): MaterializedMemory[] {
  return corpus.turns.map((t) => ({
    id: t.id,
    sessionId: t.sessionId,
    sessionIndex: t.sessionIndex,
    dayOffset: 0,
    minuteOfDay: 0,
    memoryType: "episode",
    text: t.text,
    // Deliberately constant: BenchMemory.role is a LABEL field in the repo's own
    // dataset. No system reads it, and holding it constant keeps it that way.
    role: "filler",
    itemId: null,
    confidence: UNIFORM_CONFIDENCE,
    importance: UNIFORM_IMPORTANCE,
    timestampIso: t.dateIso,
  }));
}

export function loadQuestion(questionId: string): LmeQuestion {
  const file = path.join(SPLIT_DIR, `${questionId}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as LmeQuestion;
}

export function listQuestionIds(): string[] {
  requirePrepared();
  return fs
    .readdirSync(SPLIT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}
