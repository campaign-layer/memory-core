import type { MemoryIdScope, MemoryProvider } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
} from "../types.js";
import { isExpired, normalizeKey, recencyScore } from "../utils.js";
import { BM25Index } from "../retrieval/bm25.js";
import { cosine } from "../retrieval/embedder.js";
import { rrf } from "../retrieval/fusion.js";
import type { Scored } from "../retrieval/types.js";
// Reuses the structural embedder shape the postgres provider already exports, so
// both providers accept the same objects and the package exports one such name.
import type { EmbeddingProviderLike } from "./postgres-provider.js";

// Candidates pulled from BM25 before quality re-weighting. Wider than the
// caller's limit so recency/confidence can promote a lower-ranked term match.
const CANDIDATE_MULTIPLIER = 5;
const MIN_CANDIDATES = 50;

// RRF rank constant. 60 is the usual default; larger values flatten the
// advantage of the top ranks.
const DEFAULT_RRF_K = 60;

// Cosine floor for a vector candidate. Without it every stored memory is a
// candidate for every query, so a query with no real match would come back full
// of nearest-neighbour noise instead of empty.
const DEFAULT_VECTOR_MIN_SIMILARITY = 0.25;

// After a failure, vector search is skipped for this long instead of being
// retried per request (a missing API key would otherwise cost a round trip on
// every search) or disabled until restart (a transient blip would be permanent).
const DEFAULT_EMBEDDER_COOLDOWN_MS = 60_000;

// Records embedded per await during a bulk backfill.
const BACKFILL_CHUNK = 256;

export interface InMemoryProviderOptions {
  /** When set, ingest/update store vectors and search fuses them with BM25. */
  embedder?: EmbeddingProviderLike | null;
  /** Cosine floor for a vector candidate. Default 0.25. */
  vectorMinSimilarity?: number;
  rrfK?: number;
  embedderCooldownMs?: number;
}

/** Per-stage scores, so a hybrid hit can say where it came from. */
export interface MemoryHitComponents {
  /** Raw BM25 score, absent when the hit was vector-only. */
  bm25?: number;
  bm25Rank?: number;
  /** Cosine similarity, absent when the hit was lexical-only. */
  vector?: number;
  vectorRank?: number;
  /** RRF score, and the 0..1 relevance derived from it. */
  fused: number;
  relevance: number;
  quality: number;
}

/**
 * A hit from the hybrid path. `components` is present only when vector
 * candidates actually took part: the BM25-only path returns the exact
 * `{ memory, score, reasons }` shape it always has.
 */
export interface HybridMemorySearchHit extends MemorySearchHit {
  components?: MemoryHitComponents;
}

/** Text that both rankers index: the summary is part of the searchable surface. */
function indexText(record: MemoryRecord): string {
  return record.summary ? `${record.text} ${record.summary}` : record.text;
}

function requireScope(filters: MemoryFilters): void {
  if (!filters?.tenantId || !filters?.appId) {
    throw new Error("MemoryFilters.tenantId and MemoryFilters.appId are required");
  }
}

function matchesFilters(record: MemoryRecord, filters: MemoryFilters): boolean {
  if (record.tenantId !== filters.tenantId) return false;
  if (record.appId !== filters.appId) return false;
  if (filters.actorId && record.actorId !== filters.actorId) return false;
  if (filters.threadId && record.threadId !== filters.threadId) return false;
  if (filters.memoryTypes && filters.memoryTypes.length > 0 && !filters.memoryTypes.includes(record.memoryType)) return false;
  if (filters.scope && filters.scope.length > 0 && !filters.scope.includes(record.scope)) return false;

  if (filters.metadata) {
    for (const [key, value] of Object.entries(filters.metadata)) {
      if (record.metadata[key] !== value) return false;
    }
  }

  return true;
}

// Quality signals in 0..1. These modulate relevance; they never create it.
function qualityScore(record: MemoryRecord): { quality: number; reasons: string[] } {
  const recency = recencyScore(record.lastSeenAt);
  const feedbackDelta = record.stats.positiveCount - record.stats.negativeCount;
  const feedbackBoost = Math.max(Math.min(feedbackDelta * 0.05, 0.3), -0.3);

  const quality = Math.max(
    0,
    Math.min(1, recency * 0.35 + record.confidence * 0.35 + record.importance * 0.3 + feedbackBoost),
  );

  const reasons: string[] = [];
  if (recency > 0.7) reasons.push("recent memory");
  if (record.confidence >= 0.75) reasons.push("high confidence");
  if (record.importance >= 0.75) reasons.push("high importance");
  if (feedbackBoost > 0.05) reasons.push("strong positive feedback");
  if (feedbackBoost < -0.05) reasons.push("negative feedback penalty");

  return { quality, reasons };
}

export class InMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly bm25 = new BM25Index();
  // Exact-duplicate lookup, so dedupe is O(1) instead of a full scan per observation.
  private readonly dupIndex = new Map<string, string>();

  private readonly embedder: EmbeddingProviderLike | null;
  private readonly vectorMinSimilarity: number;
  private readonly rrfK: number;
  private readonly embedderCooldownMs: number;
  // Document vectors, keyed by record id. Only active records are present.
  private readonly vectors = new Map<string, Float32Array>();
  private embedderDisabledUntil = 0;
  private embedderWarned = false;
  private backfilling: Promise<void> | null = null;

  constructor(options: InMemoryProviderOptions = {}) {
    this.embedder = options.embedder ?? null;
    this.vectorMinSimilarity = options.vectorMinSimilarity ?? DEFAULT_VECTOR_MIN_SIMILARITY;
    this.rrfK = options.rrfK ?? DEFAULT_RRF_K;
    this.embedderCooldownMs = options.embedderCooldownMs ?? DEFAULT_EMBEDDER_COOLDOWN_MS;
  }

  dumpRecords(): MemoryRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }));
  }

  /** Vectors held in memory. Diagnostics and tests; not part of MemoryProvider. */
  get vectorCount(): number {
    return this.vectors.size;
  }

  // JSON-encoded so no delimiter can be forged: a single-char separator lets
  // ("a b","c") collide with ("a","b c"), across tenants.
  private dupKey(record: MemoryRecord): string {
    return JSON.stringify([record.tenantId, record.appId, record.actorId, record.memoryType, normalizeKey(record.text)]);
  }

  // Only drops the entry if this record actually owns it. Two records can share
  // a dupKey while the map holds one id, so an unguarded delete evicts the other.
  private unindexDupKey(record: MemoryRecord): void {
    const key = this.dupKey(record);
    if (this.dupIndex.get(key) === record.id) this.dupIndex.delete(key);
  }

  // Lazy expiry: reads skip expired records instead of scanning the whole store.
  // compact() is the only full sweep and the only thing that flips status.
  private isVisible(record: MemoryRecord, now: number): boolean {
    return record.status === "active" && !isExpired(record.lastSeenAt, record.decayPolicy, now);
  }

  private index(record: MemoryRecord): void {
    // Re-indexing an existing id must retire its old dupKey, or the stale key
    // keeps resolving to a record whose text has since changed.
    const previous = this.records.get(record.id);
    if (previous) {
      this.unindexDupKey(previous);
      // Changed text invalidates the stored vector. Dropping it here is what
      // makes update() re-embed: the next embed pass sees a missing vector.
      if (indexText(previous) !== indexText(record)) this.vectors.delete(record.id);
    }

    this.records.set(record.id, record);

    // Non-active records stay out of the index entirely; otherwise compact()
    // removes the posting and a later update() silently re-adds it.
    if (record.status === "active") {
      // add() replaces an existing document, so no explicit remove is needed.
      this.bm25.add(record.id, indexText(record));
      this.dupIndex.set(this.dupKey(record), record.id);
    } else {
      this.bm25.remove(record.id);
      this.vectors.delete(record.id);
    }
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    for (const record of records) this.index(record);
    // Embedding happens here, on the write path. search() never embeds a document.
    await this.embedRecords(records);
    return records;
  }

  /**
   * Bulk restore of already-persisted records (see FileProvider.load). Indexes
   * lexically up front and embeds in the background, so a cold start is never
   * blocked on an optional model: search is BM25-only until the backfill lands.
   */
  async restore(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    for (const record of records) this.index(record);
    void this.backfillEmbeddings().catch(() => {});
    return records;
  }

  /**
   * Embeds every active record that has no vector. Idempotent and single-flight,
   * so concurrent callers share one pass.
   */
  backfillEmbeddings(): Promise<void> {
    if (this.backfilling) return this.backfilling;

    this.backfilling = (async () => {
      try {
        if (!this.embedderUsable()) return;
        const pending = [...this.records.values()].filter(
          (record) => record.status === "active" && !this.vectors.has(record.id),
        );
        for (let i = 0; i < pending.length; i += BACKFILL_CHUNK) {
          await this.embedRecords(pending.slice(i, i + BACKFILL_CHUNK));
          // embedRecords() swallows failures; stop the sweep once one trips.
          if (!this.embedderUsable()) break;
        }
      } finally {
        this.backfilling = null;
      }
    })();

    return this.backfilling;
  }

  private embedderUsable(): boolean {
    return this.embedder !== null && Date.now() >= this.embedderDisabledUntil;
  }

  /**
   * An optional model must never take retrieval down: a failure is logged once
   * and vector search is skipped until the cooldown expires.
   */
  private degrade(stage: string, error: unknown): void {
    this.embedderDisabledUntil = Date.now() + this.embedderCooldownMs;
    if (this.embedderWarned) return;
    this.embedderWarned = true;
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `[memory-core] embedder failed during ${stage}; retrieval continues BM25-only ` +
        `(retrying in ${this.embedderCooldownMs}ms, logged once): ${detail}`,
    );
  }

  /** Embeds the active, not-yet-embedded subset of `records`. Never throws. */
  private async embedRecords(records: MemoryRecord[]): Promise<void> {
    if (!this.embedderUsable() || records.length === 0) return;

    const pending: MemoryRecord[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      // Always embed the record the store actually holds, not a stale argument.
      const current = this.records.get(record.id);
      if (!current || current.status !== "active") continue;
      if (this.vectors.has(current.id) || seen.has(current.id)) continue;
      seen.add(current.id);
      pending.push(current);
    }
    if (pending.length === 0) return;

    const texts = pending.map(indexText);
    try {
      const vectors = await this.embedder!.embed(texts);
      if (vectors.length !== pending.length) {
        throw new Error(`embedder returned ${vectors.length} vectors for ${pending.length} texts`);
      }
      pending.forEach((record, i) => {
        // A record can be rewritten or archived while the embedder is in flight;
        // comparing the embedded text keeps a stale vector from landing.
        const current = this.records.get(record.id);
        if (!current || current.status !== "active") return;
        if (indexText(current) !== texts[i]) return;
        this.vectors.set(current.id, vectors[i]);
      });
    } catch (error) {
      this.degrade("ingest", error);
    }
  }

  async findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null> {
    const id = this.dupIndex.get(this.dupKey(candidate));
    if (!id) return null;
    const record = this.records.get(id);
    if (!record || !this.isVisible(record, Date.now())) return null;
    return record;
  }

  async update(record: MemoryRecord): Promise<MemoryRecord> {
    // index() retires the previous dupKey and honours the new status.
    this.index(record);
    // index() dropped the vector if the text changed, so this re-embeds it.
    await this.embedRecords([record]);
    return record;
  }

  async search(query: MemorySearchQuery): Promise<HybridMemorySearchHit[]> {
    requireScope(query.filters);
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 100);
    const minScore = query.minScore ?? 0.05;
    const now = Date.now();

    // Filter inside each ranker so scoping is applied before ranking, not after it.
    const candidateK = Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);
    const visible = (id: string): boolean => {
      const record = this.records.get(id);
      return !!record && this.isVisible(record, now) && matchesFilters(record, query.filters);
    };

    const lexical = this.bm25.search(query.query, candidateK, visible);
    const vector = await this.vectorCandidates(query.query, candidateK, visible);

    // No embedder, no vectors yet, or nothing clearing the similarity floor: the
    // BM25-only path below is the live production ranking, unchanged.
    if (vector.length === 0) return this.rankLexical(lexical, minScore, limit);
    return this.rankHybrid(lexical, vector, minScore, limit);
  }

  /** BM25 -> max-normalize -> quality modulation. */
  private rankLexical(candidates: Scored[], minScore: number, limit: number): MemorySearchHit[] {
    if (candidates.length === 0) return [];

    // Max-normalize BM25 (unbounded) to keep the documented 0..1 score contract.
    const topScore = candidates[0].score || 1;
    const hits: MemorySearchHit[] = [];

    for (const candidate of candidates) {
      const record = this.records.get(candidate.id);
      if (!record) continue;

      const relevance = Math.max(0, Math.min(1, candidate.score / topScore));
      const { quality, reasons } = qualityScore(record);
      // Relevance gates, quality modulates: zero term overlap can never score.
      const score = relevance * (0.7 + 0.3 * quality);
      if (score < minScore) continue;

      if (relevance > 0.6) reasons.unshift("strong term match");
      hits.push({ memory: record, score, reasons });
    }

    hits.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    return hits.slice(0, limit);
  }

  /**
   * RRF over the two candidate lists, then the same quality modulation. RRF is
   * rank-only, so BM25's unbounded scores and cosine never need calibrating
   * against each other — which is the whole reason a memory that shares one
   * token with the query can outrank one that shares three.
   */
  private rankHybrid(
    lexical: Scored[],
    vector: Scored[],
    minScore: number,
    limit: number,
  ): HybridMemorySearchHit[] {
    const fused = rrf([lexical, vector], this.rrfK);
    if (fused.length === 0) return [];

    const lexicalRank = rankMap(lexical);
    const lexicalScore = scoreMap(lexical);
    const vectorRank = rankMap(vector);
    const vectorScore = scoreMap(vector);

    // Max-normalize the fused score for the same 0..1 contract as above. RRF
    // scores are compressed (1/(k+rank)), so relevance here separates candidates
    // less sharply than raw BM25 does.
    const topScore = fused[0].score || 1;
    const hits: HybridMemorySearchHit[] = [];

    for (const candidate of fused) {
      const record = this.records.get(candidate.id);
      if (!record) continue;

      const relevance = Math.max(0, Math.min(1, candidate.score / topScore));
      const { quality, reasons } = qualityScore(record);
      const score = relevance * (0.7 + 0.3 * quality);
      if (score < minScore) continue;

      const inLexical = lexicalRank.has(candidate.id);
      const inVector = vectorRank.has(candidate.id);
      const components: MemoryHitComponents = {
        fused: candidate.score,
        relevance,
        quality,
      };
      const provenance: string[] = [
        inLexical && inVector ? "lexical and vector match" : inVector ? "vector match" : "lexical match",
      ];
      if (inLexical) {
        components.bm25 = lexicalScore.get(candidate.id);
        components.bm25Rank = lexicalRank.get(candidate.id);
        provenance.push(`bm25 #${components.bm25Rank}`);
      }
      if (inVector) {
        components.vector = vectorScore.get(candidate.id);
        components.vectorRank = vectorRank.get(candidate.id);
        provenance.push(`vector #${components.vectorRank}`);
      }

      hits.push({ memory: record, score, reasons: [...provenance, ...reasons], components });
    }

    hits.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    return hits.slice(0, limit);
  }

  /**
   * Brute-force cosine over stored vectors. Embeds the QUERY only — document
   * embedding happens at ingest — and returns [] rather than throwing if the
   * embedder is unavailable.
   */
  private async vectorCandidates(
    query: string,
    candidateK: number,
    filter: (id: string) => boolean,
  ): Promise<Scored[]> {
    if (!this.embedderUsable() || this.vectors.size === 0) return [];

    let queryVector: Float32Array | undefined;
    try {
      [queryVector] = await this.embedder!.embed([query]);
    } catch (error) {
      this.degrade("search", error);
      return [];
    }
    if (!queryVector || queryVector.length === 0) return [];

    const hits: Scored[] = [];
    for (const [id, vector] of this.vectors) {
      // A dimension change mid-process leaves incomparable vectors; skip them
      // instead of letting cosine throw on the read path.
      if (vector.length !== queryVector.length) continue;
      if (!filter(id)) continue;
      const score = cosine(queryVector, vector);
      if (score < this.vectorMinSimilarity) continue;
      hits.push({ id, score });
    }

    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, candidateK);
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    const now = Date.now();
    const list: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.appId === appId && record.actorId === actorId && this.isVisible(record, now)) {
        list.push(record);
      }
    }
    list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return list;
  }

  async getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null> {
    const record = this.records.get(id);
    if (!record || !this.isVisible(record, Date.now())) return null;
    if (scope && (record.tenantId !== scope.tenantId || record.appId !== scope.appId)) return null;
    return record;
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    const record = this.records.get(feedback.memoryId);
    if (!record || !this.isVisible(record, Date.now())) return null;
    // Scope is optional on the input; honour it whenever the caller supplies it.
    if (feedback.tenantId && record.tenantId !== feedback.tenantId) return null;
    if (feedback.appId && record.appId !== feedback.appId) return null;

    if (feedback.signal === "selected") {
      record.stats.selectedCount += 1;
    } else if (feedback.signal === "positive") {
      record.stats.positiveCount += 1;
    } else if (feedback.signal === "negative") {
      record.stats.negativeCount += 1;
    }

    const nowIso = new Date().toISOString();
    record.lastSeenAt = nowIso;
    record.updatedAt = nowIso;
    this.records.set(record.id, record);
    return record;
  }

  async compact(): Promise<MemoryCompactResult> {
    const now = Date.now();
    let archivedExpired = 0;
    let archivedSuperseded = 0;

    for (const record of this.records.values()) {
      const wasSuperseded = record.status === "superseded";
      if (!wasSuperseded && record.status !== "active") continue;
      if (!wasSuperseded && !isExpired(record.lastSeenAt, record.decayPolicy, now)) continue;

      record.status = "archived";
      record.updatedAt = new Date(now).toISOString();
      this.bm25.remove(record.id);
      this.vectors.delete(record.id);
      this.unindexDupKey(record);
      if (wasSuperseded) archivedSuperseded += 1;
      else archivedExpired += 1;
    }

    return { archivedExpired, archivedSuperseded };
  }

  async health() {
    return {
      ok: true,
      provider: "in-memory",
      detail:
        `records=${this.records.size}, indexed=${this.bm25.stats().documents}, ` +
        `embedder=${this.embedderLabel()}`,
    };
  }

  private embedderLabel(): string {
    if (!this.embedder) return "none";
    const id = (this.embedder as { id?: string }).id ?? "custom";
    const state = Date.now() < this.embedderDisabledUntil ? " (degraded)" : "";
    return `${id}/${this.embedder.dims}d vectors=${this.vectors.size}${state}`;
  }
}

function rankMap(list: Scored[]): Map<string, number> {
  return new Map(list.map((hit, i) => [hit.id, i + 1]));
}

function scoreMap(list: Scored[]): Map<string, number> {
  return new Map(list.map((hit) => [hit.id, hit.score]));
}
