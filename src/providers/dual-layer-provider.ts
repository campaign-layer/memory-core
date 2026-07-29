import type { MemoryIdScope, MemoryProvider, ProviderHealthStatus } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
} from "../types.js";
import { isExpired, normalizeKey, overlapScore, recencyScore, tokenize } from "../utils.js";

// Inspired by AWS Bedrock AgentCore Memory architecture
interface ShortTermEvent {
  id: string;
  recordId: string;
  tenantId: string;
  appId: string;
  actorId: string;
  sessionId: string;
  timestamp: Date;
  type: 'conversational' | 'blob' | 'system';
  role?: 'user' | 'assistant' | 'tool';
  content: string;
  metadata: Record<string, any>;
  processed: boolean;
}

interface LongTermInsight {
  id: string;
  tenantId: string;
  appId: string;
  actorId: string;
  type: 'fact' | 'preference' | 'summary' | 'pattern';
  content: string;
  confidence: number;
  importance: number;
  extractedFrom: string[]; // Event IDs that contributed
  lastUpdated: Date;
  embedding?: number[];
  tags: string[];
  stats: { selectedCount: number; positiveCount: number; negativeCount: number };
}

interface MemoryStrategy {
  name: string;
  type: 'semantic' | 'summary' | 'preference' | 'custom';
  enabled: boolean;
  extractionPrompt?: string;
  consolidationRules?: string[];
  confidenceThreshold: number;
}

const BACKGROUND_INTERVAL_MS = 30_000;

// Generic first-person state claim, e.g. "I have two cats", "my flight was delayed".
const SELF_STATEMENT = /\b(i|we|my|our)\b[^.!?]*\b(am|is|are|was|were|have|has|had|do|did|live|lives|work|works|use|uses|own|owns|need|needs|want|wants|prefer|prefers)\b/i;
const PREFERENCE_CUE = /\b(prefer|prefers|preferred|like|likes|liked|dislike|dislikes|favorite|favourite|rather)\b/i;

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export class DualLayerMemoryProvider implements MemoryProvider {
  // First-class ingested records. The two derived layers below are built from these.
  private records = new Map<string, MemoryRecord>();
  private shortTermEvents = new Map<string, ShortTermEvent>();
  private longTermInsights = new Map<string, LongTermInsight>();
  private strategies = new Map<string, MemoryStrategy>();
  private processingQueue: string[] = [];

  // Performance optimizations
  private cache = new Map<string, MemorySearchHit[]>();
  private lastCacheUpdate = new Map<string, Date>();
  private readonly cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private backgroundTimer?: NodeJS.Timeout;

  constructor() {
    this.initializeDefaultStrategies();
    this.startBackgroundProcessing();
  }

  private initializeDefaultStrategies() {
    // AWS-inspired built-in strategies
    this.strategies.set('semantic_extraction', {
      name: 'semantic_extraction',
      type: 'semantic',
      enabled: true,
      extractionPrompt: `Extract durable factual statements from the conversation, verbatim.`,
      confidenceThreshold: 0.7
    });

    this.strategies.set('preference_detection', {
      name: 'preference_detection',
      type: 'preference',
      enabled: true,
      extractionPrompt: `Identify statements expressing preferences, likes or dislikes, verbatim.`,
      confidenceThreshold: 0.7
    });

    this.strategies.set('session_summary', {
      name: 'session_summary',
      type: 'summary',
      enabled: true,
      extractionPrompt: `Summarize the recurring topics of this session.`,
      confidenceThreshold: 0.6
    });
  }

  private startBackgroundProcessing() {
    // Background consolidation similar to AWS AgentCore. unref() so a provider
    // instance never keeps the Node event loop alive.
    this.backgroundTimer = setInterval(() => {
      void this.runBackgroundPass();
    }, BACKGROUND_INTERVAL_MS);
    this.backgroundTimer.unref?.();
  }

  private async runBackgroundPass() {
    await this.processQueuedEvents();
    await this.consolidateInsights();
    this.cleanupCache();
  }

  // Releases the background timer. Callers holding a provider instance must call this
  // to allow a clean shutdown.
  close() {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = undefined;
    }
  }

  dispose() {
    this.close();
  }

  async ingest(records: MemoryRecord[]): Promise<MemoryRecord[]> {
    const stored: MemoryRecord[] = [];

    for (const record of records) {
      const id = record.id || this.newId('mem');
      const persisted: MemoryRecord = { ...record, id };
      this.records.set(id, persisted);
      stored.push(persisted);

      // Mirror into the short-term layer, which feeds long-term insight extraction.
      const event: ShortTermEvent = {
        id: this.newId('event'),
        recordId: id,
        tenantId: record.tenantId,
        appId: record.appId,
        actorId: record.actorId,
        sessionId: record.threadId || 'default',
        timestamp: new Date(),
        type: 'conversational',
        role: record.source?.metadata?.role || 'user',
        content: record.text,
        metadata: (record.metadata || {}) as Record<string, any>,
        processed: false
      };

      this.shortTermEvents.set(event.id, event);
      this.processingQueue.push(event.id);
    }

    // Drain the queue so the events just ingested are queryable before returning.
    await this.processQueuedEvents(this.processingQueue.length);
    this.invalidateCacheForRecords(stored);

    return stored;
  }

  private async processQueuedEvents(batchSize = 5) {
    const batch = this.processingQueue.splice(0, Math.max(batchSize, 0));

    for (const eventId of batch) {
      const event = this.shortTermEvents.get(eventId);
      if (!event || event.processed) continue;

      try {
        await this.extractInsightsFromEvent(event);
        event.processed = true;
      } catch (error) {
        console.error(`Failed to process event ${eventId}:`, error);
      }
    }
  }

  private async extractInsightsFromEvent(event: ShortTermEvent) {
    for (const strategy of this.strategies.values()) {
      if (!strategy.enabled) continue;

      try {
        const insights = await this.applyStrategy(strategy, event);
        for (const insight of insights) {
          await this.storeInsight(insight);
        }
      } catch (error) {
        console.error(`Strategy ${strategy.name} failed for event ${event.id}:`, error);
      }
    }
  }

  private async applyStrategy(strategy: MemoryStrategy, event: ShortTermEvent): Promise<LongTermInsight[]> {
    const insights: LongTermInsight[] = [];

    switch (strategy.type) {
      case 'semantic':
        insights.push(...await this.extractSemanticFacts(event));
        break;
      case 'preference':
        insights.push(...await this.extractUserPreferences(event));
        break;
      case 'summary':
        insights.push(...await this.createSessionSummary(event));
        break;
    }

    return insights.filter(insight => insight.confidence >= strategy.confidenceThreshold);
  }

  // Extractive and domain-general: emits source sentences verbatim, never new claims.
  // A single-sentence event is skipped because distilling it would only duplicate the record.
  private async extractSemanticFacts(event: ShortTermEvent): Promise<LongTermInsight[]> {
    const insights: LongTermInsight[] = [];
    const sentences = splitSentences(event.content);
    if (sentences.length < 2) return insights;

    for (const sentence of sentences) {
      if (tokenize(sentence).length < 3) continue;
      if (!SELF_STATEMENT.test(sentence)) continue;
      if (PREFERENCE_CUE.test(sentence)) continue; // handled by the preference strategy

      insights.push(this.makeInsight(event, 'fact', sentence, 0.7, 0.6, ['fact']));
    }

    return insights;
  }

  private async extractUserPreferences(event: ShortTermEvent): Promise<LongTermInsight[]> {
    const insights: LongTermInsight[] = [];
    const sentences = splitSentences(event.content);
    if (sentences.length < 2) return insights;

    for (const sentence of sentences) {
      if (tokenize(sentence).length < 3) continue;
      if (!PREFERENCE_CUE.test(sentence)) continue;

      insights.push(this.makeInsight(event, 'preference', sentence, 0.7, 0.6, ['preference']));
    }

    return insights;
  }

  private async createSessionSummary(event: ShortTermEvent): Promise<LongTermInsight[]> {
    // Create session summary after enough events accumulate in a session
    const sessionEvents = Array.from(this.shortTermEvents.values())
      .filter(e => e.tenantId === event.tenantId && e.appId === event.appId &&
                   e.sessionId === event.sessionId && e.actorId === event.actorId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    if (sessionEvents.length < 5) return [];

    const topics = this.extractTopics(sessionEvents);
    return [
      this.makeInsight(
        event,
        'summary',
        `Session summary: ${sessionEvents.length} messages exchanged about ${topics}`,
        0.6,
        0.5,
        ['summary', 'session'],
        sessionEvents.map(e => e.id),
      ),
    ];
  }

  // Most frequent content tokens across the session. No topic taxonomy.
  private extractTopics(events: ShortTermEvent[]): string {
    const counts = new Map<string, number>();
    for (const event of events) {
      for (const token of new Set(tokenize(event.content))) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }

    const top = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([token]) => token);

    return top.length > 0 ? top.join(', ') : 'general conversation';
  }

  private makeInsight(
    event: ShortTermEvent,
    type: LongTermInsight['type'],
    content: string,
    confidence: number,
    importance: number,
    tags: string[],
    extractedFrom: string[] = [event.id],
  ): LongTermInsight {
    return {
      id: this.newId('insight'),
      tenantId: event.tenantId,
      appId: event.appId,
      actorId: event.actorId,
      type,
      content,
      confidence,
      importance,
      extractedFrom,
      lastUpdated: new Date(),
      tags: [...new Set([...tags, ...tokenize(content).slice(0, 3)])],
      stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0 },
    };
  }

  private newId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private async storeInsight(insight: LongTermInsight) {
    // Check for existing similar insights (deduplication like AWS)
    const existing = this.findSimilarInsight(insight);
    if (existing) {
      // Consolidate with existing insight
      existing.confidence = Math.max(existing.confidence, insight.confidence);
      existing.extractedFrom.push(...insight.extractedFrom);
      existing.lastUpdated = new Date();
    } else {
      this.longTermInsights.set(insight.id, insight);
    }
  }

  private findSimilarInsight(insight: LongTermInsight): LongTermInsight | null {
    for (const existing of this.longTermInsights.values()) {
      if (existing.tenantId === insight.tenantId &&
          existing.appId === insight.appId &&
          existing.actorId === insight.actorId &&
          existing.type === insight.type &&
          this.calculateTextSimilarity(existing.content, insight.content) > 0.8) {
        return existing;
      }
    }
    return null;
  }

  private calculateTextSimilarity(text1: string, text2: string): number {
    const words1 = new Set(normalizeKey(text1).split(/\s+/));
    const words2 = new Set(normalizeKey(text2).split(/\s+/));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  // Token overlap plus character-trigram similarity, so morphological variants
  // ("allergies" / "allergic") still retrieve. Both are domain-general.
  private queryTextSimilarity(query: string, text: string): number {
    const lexical = overlapScore(query, text);
    const fuzzy = this.trigramSimilarity(query, text);
    return Math.max(lexical, fuzzy * 0.8);
  }

  private trigramSimilarity(a: string, b: string): number {
    const ga = this.trigrams(a);
    const gb = this.trigrams(b);
    if (ga.size === 0 || gb.size === 0) return 0;

    let shared = 0;
    for (const gram of ga) {
      if (gb.has(gram)) shared++;
    }
    return (2 * shared) / (ga.size + gb.size);
  }

  private trigrams(text: string): Set<string> {
    const grams = new Set<string>();
    for (const word of normalizeKey(text).replace(/[^a-z0-9]+/g, " ").split(" ")) {
      if (!word) continue;
      const padded = ` ${word} `;
      for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3));
    }
    return grams;
  }

  private async consolidateInsights() {
    // Background consolidation process (like AWS)
    const groupedInsights = this.groupInsightsByActor();

    for (const [actorKey, insights] of groupedInsights) {
      await this.deduplicateAndConsolidate(actorKey, insights);
    }
  }

  private groupInsightsByActor(): Map<string, LongTermInsight[]> {
    const grouped = new Map<string, LongTermInsight[]>();

    for (const insight of this.longTermInsights.values()) {
      const key = `${insight.tenantId}:${insight.appId}:${insight.actorId}`;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(insight);
    }

    return grouped;
  }

  private async deduplicateAndConsolidate(_actorKey: string, insights: LongTermInsight[]) {
    // Find and merge duplicate insights
    const removed = new Set<string>();

    for (let i = 0; i < insights.length; i++) {
      if (removed.has(insights[i].id)) continue;
      for (let j = i + 1; j < insights.length; j++) {
        if (removed.has(insights[j].id)) continue;
        const similarity = this.calculateTextSimilarity(insights[i].content, insights[j].content);
        if (similarity > 0.7 && insights[i].type === insights[j].type) {
          // Merge insights
          insights[i].confidence = Math.max(insights[i].confidence, insights[j].confidence);
          insights[i].importance = Math.max(insights[i].importance, insights[j].importance);
          insights[i].extractedFrom.push(...insights[j].extractedFrom);
          insights[i].tags = [...new Set([...insights[i].tags, ...insights[j].tags])];
          insights[i].lastUpdated = new Date();

          removed.add(insights[j].id);
        }
      }
    }

    for (const id of removed) {
      this.longTermInsights.delete(id);
    }
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    const filters = this.requireFilters(query.filters);
    this.pruneExpired();

    const cacheKey = this.searchCacheKey(query, filters);
    if (this.isCacheValid(cacheKey)) {
      return [...(this.cache.get(cacheKey) ?? [])];
    }

    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const minScore = query.minScore ?? 0.1;

    const hits: MemorySearchHit[] = [];

    // Search the canonical records and the derived insights. Short-term events are
    // verbatim mirrors of records, so searching them too would only return duplicates
    // and let a thread-scoped mirror escape a filter that excluded its record.
    for (const candidate of [...this.records.values(), ...this.insightRecords()]) {
      if (candidate.status !== 'active') continue;
      if (!this.matchesFilters(candidate, filters)) continue;

      const { score, reasons } = this.scoreRecord(candidate, query.query);
      if (score < minScore) continue;
      hits.push({ memory: candidate, score, reasons });
    }

    hits.sort((a, b) => b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
    const results = hits.slice(0, limit);

    this.cache.set(cacheKey, results);
    this.lastCacheUpdate.set(cacheKey, new Date());

    return [...results];
  }

  private scoreRecord(record: MemoryRecord, query: string): { score: number; reasons: string[] } {
    const similarity = this.queryTextSimilarity(query, record.text);
    const reasons: string[] = [];
    if (similarity <= 0) return { score: 0, reasons };

    const recency = recencyScore(record.lastSeenAt);
    const feedbackDelta = record.stats.positiveCount - record.stats.negativeCount;
    const feedbackBoost = Math.max(Math.min(feedbackDelta * 0.02, 0.12), -0.12);

    // Similarity gates the score: quality signals modulate it, they never create a hit.
    const quality = record.confidence * 0.5 + record.importance * 0.3 + recency * 0.2;
    const score = Math.max(0, Math.min(1, similarity * (0.6 + 0.4 * quality) + feedbackBoost));

    if (similarity > 0.35) reasons.push('high text similarity');
    if (record.confidence >= 0.75) reasons.push('high confidence');
    if (record.importance >= 0.75) reasons.push('high importance');
    if (recency > 0.7) reasons.push('recent memory');
    if (feedbackBoost > 0.05) reasons.push('strong positive feedback');
    if (feedbackBoost < -0.05) reasons.push('negative feedback penalty');
    if (record.source.sourceType === 'dual_layer_insight') reasons.push('long-term insight');

    return { score, reasons };
  }

  // tenantId/appId are mandatory: an under-specified filter must return nothing,
  // never every tenant's memories.
  private requireFilters(filters: MemoryFilters | undefined): MemoryFilters {
    if (!filters?.tenantId || !filters?.appId) {
      throw new Error("memory filters must include tenantId and appId");
    }
    return filters;
  }

  private matchesFilters(record: MemoryRecord, filters: MemoryFilters): boolean {
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

  private insightRecords(): MemoryRecord[] {
    return Array.from(this.longTermInsights.values()).map((insight) => this.insightToMemoryRecord(insight));
  }

  private insightToMemoryRecord(insight: LongTermInsight): MemoryRecord {
    return {
      id: insight.id,
      tenantId: insight.tenantId,
      appId: insight.appId,
      actorId: insight.actorId,
      threadId: null,
      scope: 'actor',
      memoryType: insight.type,
      text: insight.content,
      summary: insight.content.length > 100 ? `${insight.content.slice(0, 100)}...` : insight.content,
      metadata: { tags: insight.tags, extractedFrom: insight.extractedFrom },
      confidence: insight.confidence,
      importance: insight.importance,
      status: 'active',
      source: {
        sourceType: 'dual_layer_insight',
        sourceId: insight.id
      },
      decayPolicy: { kind: 'none' },
      firstSeenAt: insight.lastUpdated.toISOString(),
      lastSeenAt: insight.lastUpdated.toISOString(),
      createdAt: insight.lastUpdated.toISOString(),
      updatedAt: insight.lastUpdated.toISOString(),
      stats: { ...insight.stats, accessCount: 0 }
    };
  }

  private eventToMemoryRecord(event: ShortTermEvent): MemoryRecord {
    return {
      id: event.id,
      tenantId: event.tenantId,
      appId: event.appId,
      actorId: event.actorId,
      threadId: event.sessionId === 'default' ? null : event.sessionId,
      scope: 'thread',
      memoryType: 'episode',
      text: event.content,
      summary: event.content.length > 100 ? `${event.content.slice(0, 100)}...` : event.content,
      metadata: event.metadata,
      confidence: 0.8,
      importance: 0.6,
      status: 'active',
      source: {
        sourceType: 'dual_layer_event',
        sourceId: event.id,
        metadata: event.role ? { role: event.role } : undefined
      },
      decayPolicy: { kind: 'time', ttlDays: 7 },
      firstSeenAt: event.timestamp.toISOString(),
      lastSeenAt: event.timestamp.toISOString(),
      createdAt: event.timestamp.toISOString(),
      updatedAt: event.timestamp.toISOString(),
      stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0, accessCount: 0 }
    };
  }

  // Cache key covers every field that changes the result set, so two different
  // filtered queries can never collide.
  private searchCacheKey(query: MemorySearchQuery, filters: MemoryFilters): string {
    const variant = {
      query: query.query,
      threadId: filters.threadId ?? null,
      memoryTypes: [...(filters.memoryTypes ?? [])].sort(),
      scope: [...(filters.scope ?? [])].sort(),
      metadata: filters.metadata
        ? Object.entries(filters.metadata).sort(([a], [b]) => a.localeCompare(b))
        : null,
      limit: query.limit ?? null,
      minScore: query.minScore ?? null,
    };
    return `search|${filters.tenantId}|${filters.appId}|${filters.actorId ?? '*'}|${JSON.stringify(variant)}`;
  }

  private isCacheValid(key: string): boolean {
    const lastUpdate = this.lastCacheUpdate.get(key);
    if (!lastUpdate) return false;
    return Date.now() - lastUpdate.getTime() < this.cacheTimeout;
  }

  // Invalidate every (tenant, app) touched by a batch, not just the first record's.
  private invalidateCacheForRecords(records: Array<{ tenantId: string; appId: string }>) {
    const prefixes = new Set(records.map((record) => `search|${record.tenantId}|${record.appId}|`));
    for (const prefix of prefixes) {
      this.invalidateCache(prefix);
    }
  }

  private invalidateCache(prefix: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        this.lastCacheUpdate.delete(key);
      }
    }
  }

  private cleanupCache() {
    const now = Date.now();
    for (const [key, lastUpdate] of this.lastCacheUpdate.entries()) {
      if (now - lastUpdate.getTime() > this.cacheTimeout) {
        this.cache.delete(key);
        this.lastCacheUpdate.delete(key);
      }
    }
  }

  private pruneExpired(): number {
    let archivedExpired = 0;
    const now = Date.now();
    for (const record of this.records.values()) {
      if (record.status !== 'active') continue;
      if (isExpired(record.lastSeenAt, record.decayPolicy, now)) {
        record.status = 'archived';
        record.updatedAt = new Date(now).toISOString();
        archivedExpired += 1;
      }
    }
    return archivedExpired;
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
    const insight = this.longTermInsights.get(record.id);
    if (insight) {
      insight.content = record.text;
      insight.confidence = record.confidence;
      insight.importance = record.importance;
      insight.lastUpdated = new Date();
      this.invalidateCacheForRecords([record]);
      return this.insightToMemoryRecord(insight);
    }

    this.records.set(record.id, record);
    this.invalidateCacheForRecords([record]);
    return record;
  }

  async getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null> {
    this.pruneExpired();
    const found = this.resolveById(id);
    if (!found) return null;
    if (scope && (found.tenantId !== scope.tenantId || found.appId !== scope.appId)) return null;
    return found;
  }

  private resolveById(id: string): MemoryRecord | null {
    const record = this.records.get(id);
    if (record) return record.status === 'active' ? record : null;

    const insight = this.longTermInsights.get(id);
    if (insight) return this.insightToMemoryRecord(insight);

    const event = this.shortTermEvents.get(id);
    if (event) return this.eventToMemoryRecord(event);

    return null;
  }

  async listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]> {
    if (!tenantId || !appId || !actorId) {
      throw new Error("listByActor requires tenantId, appId and actorId");
    }
    this.pruneExpired();

    const matches = (record: MemoryRecord) =>
      record.tenantId === tenantId && record.appId === appId &&
      record.actorId === actorId && record.status === 'active';

    const list: MemoryRecord[] = [];
    for (const record of this.records.values()) {
      if (matches(record)) list.push(record);
    }
    for (const insight of this.insightRecords()) {
      if (matches(insight)) list.push(insight);
    }

    list.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    return list;
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    this.pruneExpired();

    // Scope is optional on the input; honour it whenever the caller supplies it,
    // so an id from another tenant cannot be nudged or read back.
    if (feedback.tenantId || feedback.appId) {
      const target = this.resolveById(feedback.memoryId);
      if (!target) return null;
      if (feedback.tenantId && target.tenantId !== feedback.tenantId) return null;
      if (feedback.appId && target.appId !== feedback.appId) return null;
    }

    const now = new Date().toISOString();

    const record = this.records.get(feedback.memoryId);
    if (record && record.status === 'active') {
      this.applySignal(record.stats, feedback.signal);
      record.lastSeenAt = now;
      record.updatedAt = now;
      this.invalidateCacheForRecords([record]);
      return record;
    }

    const insight = this.longTermInsights.get(feedback.memoryId);
    if (insight) {
      this.applySignal(insight.stats, feedback.signal);
      if (feedback.signal === 'positive') insight.confidence = Math.min(1, insight.confidence + 0.05);
      if (feedback.signal === 'negative') insight.confidence = Math.max(0, insight.confidence - 0.05);
      insight.lastUpdated = new Date();
      this.invalidateCacheForRecords([insight]);
      return this.insightToMemoryRecord(insight);
    }

    return null;
  }

  private applySignal(stats: { selectedCount: number; positiveCount: number; negativeCount: number }, signal: MemoryFeedbackInput['signal']) {
    if (signal === 'selected') stats.selectedCount += 1;
    else if (signal === 'positive') stats.positiveCount += 1;
    else if (signal === 'negative') stats.negativeCount += 1;
  }

  async compact(): Promise<MemoryCompactResult> {
    const archivedExpired = this.pruneExpired();
    const now = Date.now();
    const eventRetentionMs = 30 * 24 * 60 * 60 * 1000;

    let archivedEvents = 0;
    for (const [id, event] of this.shortTermEvents.entries()) {
      if (now - event.timestamp.getTime() > eventRetentionMs) {
        this.shortTermEvents.delete(id);
        archivedEvents++;
      }
    }

    let archivedInsights = 0;
    for (const [id, insight] of this.longTermInsights.entries()) {
      if (insight.confidence < 0.3) { // Remove low-confidence insights
        this.longTermInsights.delete(id);
        archivedInsights++;
      }
    }

    this.cache.clear();
    this.lastCacheUpdate.clear();

    return { archivedExpired: archivedExpired + archivedEvents + archivedInsights, archivedSuperseded: 0 };
  }

  async health(): Promise<ProviderHealthStatus> {
    return {
      ok: true,
      provider: "dual-layer",
      detail: `records=${this.records.size}, events=${this.shortTermEvents.size}, insights=${this.longTermInsights.size}`,
    };
  }
}
