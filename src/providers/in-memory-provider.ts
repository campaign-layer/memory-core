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

// Candidates pulled from BM25 before quality re-weighting. Wider than the
// caller's limit so recency/confidence can promote a lower-ranked term match.
const CANDIDATE_MULTIPLIER = 5;
const MIN_CANDIDATES = 50;

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

  dumpRecords(): MemoryRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }));
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
    if (previous) this.unindexDupKey(previous);

    this.records.set(record.id, record);

    // Non-active records stay out of the index entirely; otherwise compact()
    // removes the posting and a later update() silently re-adds it.
    if (record.status === "active") {
      // add() replaces an existing document, so no explicit remove is needed.
      this.bm25.add(record.id, record.summary ? `${record.text} ${record.summary}` : record.text);
      this.dupIndex.set(this.dupKey(record), record.id);
    } else {
      this.bm25.remove(record.id);
    }
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    for (const record of records) this.index(record);
    return records;
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
    return record;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    requireScope(query.filters);
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 100);
    const minScore = query.minScore ?? 0.05;
    const now = Date.now();

    // Filter inside BM25 so scoping is applied before ranking, not after it.
    const candidateK = Math.max(limit * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);
    const candidates = this.bm25.search(query.query, candidateK, (id) => {
      const record = this.records.get(id);
      return !!record && this.isVisible(record, now) && matchesFilters(record, query.filters);
    });
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
      detail: `records=${this.records.size}, indexed=${this.bm25.stats().documents}`,
    };
  }
}
