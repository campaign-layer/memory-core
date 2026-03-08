import type { MemoryProvider } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
} from "../types.js";
import { isExpired, overlapScore, recencyScore } from "../utils.js";

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

function computeScore(record: MemoryRecord, query: string): { score: number; reasons: string[] } {
  const semantic = overlapScore(query, record.text);
  const recency = recencyScore(record.lastSeenAt);
  const confidence = record.confidence;
  const importance = record.importance;
  const feedbackDelta = record.stats.positiveCount - record.stats.negativeCount;
  const feedbackBoost = Math.max(Math.min(feedbackDelta * 0.02, 0.12), -0.12);

  const score = semantic * 0.55 + recency * 0.15 + confidence * 0.15 + importance * 0.1 + feedbackBoost;

  const reasons: string[] = [];
  if (semantic > 0.35) reasons.push("high lexical overlap");
  if (recency > 0.7) reasons.push("recent memory");
  if (confidence >= 0.75) reasons.push("high confidence");
  if (importance >= 0.75) reasons.push("high importance");
  if (feedbackBoost > 0.05) reasons.push("strong positive feedback");
  if (feedbackBoost < -0.05) reasons.push("negative feedback penalty");

  return { score, reasons };
}

export class InMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, MemoryRecord>();

  dumpRecords(): MemoryRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }));
  }

  private pruneExpired(): number {
    let archivedExpired = 0;
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (isExpired(record.lastSeenAt, record.decayPolicy, now)) {
        record.status = "archived";
        record.updatedAt = new Date(now).toISOString();
        this.records.set(record.id, record);
        archivedExpired += 1;
      }
    }
    return archivedExpired;
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    for (const record of records) {
      this.records.set(record.id, record);
    }
    return records;
  }

  async findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null> {
    this.pruneExpired();
    for (const record of this.records.values()) {
      if (
        record.tenantId === candidate.tenantId &&
        record.appId === candidate.appId &&
        record.actorId === candidate.actorId &&
        record.memoryType === candidate.memoryType &&
        record.text.toLowerCase() === candidate.text.toLowerCase() &&
        record.status === "active"
      ) {
        return record;
      }
    }
    return null;
  }

  async update(record: MemoryRecord): Promise<MemoryRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    this.pruneExpired();
    const limit = Math.min(Math.max(query.limit ?? 8, 1), 100);
    const minScore = query.minScore ?? 0.2;
    const hits: MemorySearchHit[] = [];

    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (!matchesFilters(record, query.filters)) continue;

      const { score, reasons } = computeScore(record, query.query);
      if (score < minScore) continue;
      hits.push({ memory: record, score, reasons });
    }

    hits.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    return hits.slice(0, limit);
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    this.pruneExpired();
    const list: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.appId === appId && record.actorId === actorId && record.status === "active") {
        list.push(record);
      }
    }
    list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return list;
  }

  async getById(id: string): Promise<MemoryRecord | null> {
    this.pruneExpired();
    const record = this.records.get(id);
    if (!record || record.status !== "active") return null;
    return record;
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    this.pruneExpired();
    const record = this.records.get(feedback.memoryId);
    if (!record || record.status !== "active") return null;

    if (feedback.signal === "selected") {
      record.stats.selectedCount += 1;
    } else if (feedback.signal === "positive") {
      record.stats.positiveCount += 1;
    } else if (feedback.signal === "negative") {
      record.stats.negativeCount += 1;
    }

    record.lastSeenAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    this.records.set(record.id, record);
    return record;
  }

  async compact(): Promise<MemoryCompactResult> {
    const archivedExpired = this.pruneExpired();
    return { archivedExpired, archivedSuperseded: 0 };
  }

  async health() {
    return {
      ok: true,
      provider: "in-memory",
      detail: `records=${this.records.size}`,
    };
  }
}
