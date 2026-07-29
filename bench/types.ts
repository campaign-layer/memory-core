import type { MemoryRecord, MemoryType } from "../src/types.js";

export const FAMILIES = [
  "single-hop",
  "multi-session",
  "temporal",
  "knowledge-update",
  "abstention",
  "preference",
] as const;

export type Family = (typeof FAMILIES)[number];

export type MemoryRole = "gold" | "superseded" | "hard-negative" | "filler";

/**
 * A corpus memory as stored in the generated dataset. Timestamps are RELATIVE
 * (dayOffset = days before the run's time anchor) so the fixture file never
 * embeds a wall-clock value and stays byte-identical across runs.
 */
export interface BenchMemory {
  id: string;
  sessionId: string;
  sessionIndex: number;
  dayOffset: number;
  minuteOfDay: number;
  memoryType: MemoryType;
  text: string;
  role: MemoryRole;
  itemId: string | null;
  confidence: number;
  importance: number;
}

export interface EvalItem {
  id: string;
  family: Family;
  query: string;
  goldMemoryIds: string[];
  distractorNote?: string;
  /** knowledge-update: retrieving these above gold is a stale hit. */
  supersededMemoryIds?: string[];
  /** true when the query is only answerable with every gold memory (multi-session). */
  requiresAll?: boolean;
  hardNegativeIds?: string[];
  /** The unique entity the query is keyed on. Used by the dataset validator. */
  anchor?: string;
}

export interface DatasetMeta {
  name: string;
  version: string;
  seed: number;
  size: "small" | "large";
  generatedBy: string;
  counts: {
    items: number;
    memories: number;
    sessions: number;
    byFamily: Record<string, number>;
    byRole: Record<string, number>;
  };
}

export interface Dataset {
  meta: DatasetMeta;
  memories: BenchMemory[];
  items: EvalItem[];
}

/** A BenchMemory with absolute timestamps resolved against the run's time anchor. */
export interface MaterializedMemory extends BenchMemory {
  timestampIso: string;
}

export interface RankedHit {
  id: string;
  score: number;
}

/** Thrown by setup() to mark a system as skipped (e.g. missing credentials). */
export class SkipSystem extends Error {}

export interface BenchSystem {
  name: string;
  /** Human-readable note printed in the report (e.g. "hash embedder, 256d"). */
  note?: string;
  /**
   * Score below which this system would normally drop a hit. Used to report an
   * "at the system's own gate" operating point without a second search call.
   */
  defaultMinScore: number;
  /** True when wall-clock latency is dominated by network RTT, not retrieval work. */
  networkBound?: boolean;
  setup?(): Promise<void>;
  ingest(memories: MaterializedMemory[]): Promise<void>;
  search(query: string, k: number): Promise<RankedHit[]>;
  teardown?(): Promise<void>;
}

export interface SystemContext {
  seed: number;
  /** Every corpus id, needed by systems that rank without an index (random). */
  allMemoryIds: string[];
  embedderName: string;
  workDir: string;
  /** Stable per-run identifier, used to namespace remote state. */
  runId: string;
}

/** Fixed identity for every record in the corpus. */
export const BENCH_TENANT = "bench-tenant";
export const BENCH_APP = "bench-app";
export const BENCH_ACTOR = "bench-actor";

/** Materialized memory -> MemoryRecord for MemoryProvider-backed systems. */
export function toMemoryRecord(m: MaterializedMemory): MemoryRecord {
  return {
    id: m.id,
    tenantId: BENCH_TENANT,
    appId: BENCH_APP,
    actorId: BENCH_ACTOR,
    threadId: m.sessionId,
    scope: "actor",
    memoryType: m.memoryType,
    text: m.text,
    summary: null,
    metadata: { sessionId: m.sessionId, sessionIndex: m.sessionIndex },
    confidence: m.confidence,
    importance: m.importance,
    // "none" on purpose: TTL decay would archive the whole corpus and silently
    // zero out every score, which is a harness artifact, not a system property.
    status: "active",
    source: { sourceType: "bench", sourceId: m.id, sourceSessionId: m.sessionId },
    decayPolicy: { kind: "none" },
    firstSeenAt: m.timestampIso,
    lastSeenAt: m.timestampIso,
    createdAt: m.timestampIso,
    updatedAt: m.timestampIso,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0, accessCount: 0 },
  };
}
