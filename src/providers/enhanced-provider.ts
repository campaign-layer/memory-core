import type { MemoryIdScope, MemoryProvider } from "../provider.js";
import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryRecord,
  MemorySearchHit,
  MemorySearchQuery,
  MemoryType,
} from "../types.js";
import { isExpired, normalizeText, tokenize } from "../utils.js";

// Enhanced memory record with additional metadata
interface EnhancedMemoryRecord extends MemoryRecord {
  embedding?: number[]; // Semantic embedding vector
  temporalMetadata?: {
    extractedDates?: string[];
    extractedEvents?: string[];
    temporalOrder?: number; // Sequence order within session
    isTemporallyRelevant?: boolean;
  };
  entityMetadata?: {
    extractedEntities?: ExtractedEntity[];
    hasProblemLanguage?: boolean;
  };
  episodeId?: string; // Groups related memories
}

// Structural entity kinds. Driven by general patterns only - no domain word lists.
type EntityType = 'PROPER_NOUN' | 'ACRONYM' | 'IDENTIFIER' | 'QUOTED' | 'NUMBER' | 'TIME' | 'PROBLEM';

interface ExtractedEntity {
  text: string;
  type: EntityType;
  confidence: number;
}

// Simple embedding service interface (would use actual embeddings in production)
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  similarity(a: number[], b: number[]): number;
}

// Mock embedding service for demonstration
class MockEmbeddingService implements EmbeddingService {
  private embeddingCache = new Map<string, number[]>();
  
  async embed(text: string): Promise<number[]> {
    // Simple hash-based mock embedding for demonstration
    // In production, use actual models like sentence-transformers
    const cached = this.embeddingCache.get(text);
    if (cached) return cached;
    
    const normalized = normalizeText(text.toLowerCase());
    const tokens = tokenize(normalized);
    
    // Create a simple 384-dimensional mock embedding based on token distribution
    const embedding = new Array(384).fill(0);
    
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      // Simple hash to distribute token influence across dimensions
      const hash = this.simpleHash(token);
      for (let j = 0; j < 384; j++) {
        embedding[j] += Math.sin(hash + j) * (1 / Math.sqrt(tokens.length));
      }
    }
    
    // Normalize the embedding
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (norm > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= norm;
      }
    }
    
    this.embeddingCache.set(text, embedding);
    return embedding;
  }
  
  similarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return Math.max(0, dot); // Cosine similarity (assuming normalized vectors)
  }
  
  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }
}

// Temporal expression extractor
class TemporalExtractor {
  private temporalPatterns = [
    // Dates
    /\b(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{1,2}-\d{1,2})\b/g,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi,
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/gi,
    
    // Relative temporal expressions
    /\b(yesterday|today|tomorrow|last\s+\w+|next\s+\w+|this\s+\w+)\b/gi,
    /\b(\d+)\s+(days?|weeks?|months?|years?)\s+(ago|before|after|later)\b/gi,
    /\b(first|second|third|last|final|initial)\b/gi,
    
    // Temporal order words
    /\b(before|after|during|while|when|then|next|previously|subsequently)\b/gi,
  ];
  
  extractTemporalInfo(text: string): {
    extractedDates: string[];
    extractedEvents: string[];
    temporalOrder?: number;
    isTemporallyRelevant: boolean;
  } {
    const extractedDates: string[] = [];
    const extractedEvents: string[] = [];
    
    // Extract dates and temporal expressions
    for (const pattern of this.temporalPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        extractedDates.push(...matches);
      }
    }
    
    // Look for event markers
    const eventPatterns = [
      /\b(service|appointment|meeting|event|visit|trip|purchase|issue|problem)\b/gi,
    ];
    
    for (const pattern of eventPatterns) {
      const matches = text.match(pattern);
      if (matches) {
        extractedEvents.push(...matches);
      }
    }
    
    // Determine temporal relevance
    const isTemporallyRelevant = extractedDates.length > 0 || 
                                extractedEvents.length > 0 ||
                                /\b(first|second|third|last|before|after|when|then)\b/i.test(text);
    
    return {
      extractedDates: Array.from(new Set(extractedDates)),
      extractedEvents: Array.from(new Set(extractedEvents)),
      isTemporallyRelevant,
    };
  }
  
  extractTemporalOrder(text: string, sessionTexts: string[]): number {
    // Simple temporal ordering based on position in session and temporal cues
    const orderCues = [
      { pattern: /\bfirst\b/i, weight: -10 },
      { pattern: /\binitial\b/i, weight: -8 },
      { pattern: /\bstarted\b/i, weight: -6 },
      { pattern: /\bthen\b/i, weight: 0 },
      { pattern: /\bnext\b/i, weight: 2 },
      { pattern: /\bafter\b/i, weight: 4 },
      { pattern: /\blast\b/i, weight: 8 },
      { pattern: /\bfinal\b/i, weight: 10 },
    ];
    
    let order = 0;
    for (const cue of orderCues) {
      if (cue.pattern.test(text)) {
        order += cue.weight;
      }
    }
    
    return order;
  }
}

// Enhanced provider with semantic and temporal capabilities
export class EnhancedMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, EnhancedMemoryRecord>();
  private readonly embeddingService = new MockEmbeddingService();
  private readonly temporalExtractor = new TemporalExtractor();
  private readonly episodeMap = new Map<string, Set<string>>(); // episodeId -> recordIds

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
    const enhancedRecords: EnhancedMemoryRecord[] = [];
    
    // Group records by episode (session)
    const sessionGroups = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const sessionKey = `${record.tenantId}:${record.appId}:${record.actorId}:${record.threadId}`;
      if (!sessionGroups.has(sessionKey)) {
        sessionGroups.set(sessionKey, []);
      }
      sessionGroups.get(sessionKey)!.push(record);
    }
    
    // Process each session
    for (const [sessionKey, sessionRecords] of sessionGroups) {
      const sessionTexts = sessionRecords.map(r => r.text);
      const episodeId = `episode_${sessionKey}_${Date.now()}`;
      
      for (let i = 0; i < sessionRecords.length; i++) {
        const record = sessionRecords[i];
        const enhanced: EnhancedMemoryRecord = {
          ...record,
          episodeId,
        };
        
        try {
          // Generate semantic embedding
          enhanced.embedding = await this.embeddingService.embed(record.text);
          
          // Extract temporal metadata
          const temporalInfo = this.temporalExtractor.extractTemporalInfo(record.text);
          const temporalOrder = this.temporalExtractor.extractTemporalOrder(record.text, sessionTexts);
          
          enhanced.temporalMetadata = {
            ...temporalInfo,
            temporalOrder,
          };
          
          // Structural entity extraction
          const entities = this.extractEntities(record.text);
          enhanced.entityMetadata = {
            extractedEntities: entities,
            hasProblemLanguage: entities.some(e => e.type === 'PROBLEM'),
          };

        } catch (error) {
          console.warn(`Failed to enhance record ${record.id}:`, error);
        }
        
        enhancedRecords.push(enhanced);
        this.records.set(enhanced.id, enhanced);
      }
      
      // Track episode
      const recordIds = new Set(sessionRecords.map(r => r.id));
      this.episodeMap.set(episodeId, recordIds);
    }
    
    return enhancedRecords;
  }
  
  // General structural entity extraction: proper-noun runs, acronyms, alphanumeric
  // identifiers, quoted spans, numbers, calendar/relative time and problem language.
  private extractEntities(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    const push = (value: string, type: EntityType, confidence: number) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      const key = `${type}:${trimmed.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      entities.push({ text: trimmed, type, confidence });
    };

    // Quoted spans are explicit author-marked entities.
    for (const match of text.matchAll(/["'‘’“”]([^"'‘’“”]{2,80})["'‘’“”]/g)) {
      push(match[1], 'QUOTED', 0.9);
    }

    for (const properNoun of this.extractProperNounRuns(text)) {
      push(properNoun, 'PROPER_NOUN', 0.7);
    }

    // Acronyms (runs of capitals) and model-style identifiers (letters then digits).
    for (const match of text.matchAll(/\b\p{Lu}{2,}\b/gu)) push(match[0], 'ACRONYM', 0.7);
    for (const match of text.matchAll(/\b\p{L}+\p{N}[\p{L}\p{N}]*\b/gu)) push(match[0], 'IDENTIFIER', 0.7);

    for (const match of text.matchAll(/\b\d+(?:[.,]\d+)*\b/g)) push(match[0], 'NUMBER', 0.5);

    const timePatterns: Array<[RegExp, number]> = [
      [/\b(?:\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})\b/g, 0.9],
      [/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|tember|ober|ember)?\b/gi, 0.8],
      [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi, 0.7],
      [/\b(?:yesterday|today|tomorrow|ago|later|earlier|first|last|initial|final|before|after|since|until)\b/gi, 0.6],
    ];
    for (const [pattern, confidence] of timePatterns) {
      for (const match of text.matchAll(pattern)) push(match[0], 'TIME', confidence);
    }

    // Generic problem predicates (common English, not domain terms).
    for (const match of text.matchAll(/\b(?:issue|issues|problem|problems|trouble|malfunction|broken|failed|failing|failure|error|errors|not working)\b/gi)) {
      push(match[0], 'PROBLEM', 0.8);
    }

    return entities;
  }

  // Runs of capitalized tokens. A lone sentence-initial capital is skipped because
  // capitalization there is grammatical, not proper-noun evidence.
  private extractProperNounRuns(text: string): string[] {
    const runs: string[] = [];

    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const tokens = sentence.trim().split(/\s+/);
      let run: string[] = [];
      let runStartsSentence = false;

      const flush = () => {
        if (run.length > 1 || (run.length === 1 && !runStartsSentence)) {
          runs.push(run.join(" "));
        }
        run = [];
      };

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
        if (token && /^\p{Lu}[\p{L}\p{N}'\u2019-]*$/u.test(token)) {
          if (run.length === 0) runStartsSentence = i === 0;
          run.push(token);
          continue;
        }
        flush();
      }
      flush();
    }

    return runs;
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
    const existing = this.records.get(record.id);
    if (existing) {
      const updated = { ...existing, ...record };
      this.records.set(record.id, updated);
      return updated;
    }
    this.records.set(record.id, record as EnhancedMemoryRecord);
    return record;
  }

  private async classifyQuery(query: string): Promise<{
    type: 'temporal' | 'factual' | 'comparative' | 'preference';
    temporalType?: 'sequence' | 'duration' | 'specific_time' | 'relative_time';
    confidence: number;
    entities: string[];
  }> {
    const queryLower = query.toLowerCase();

    const isTemporal = /\b(first|second|third|last|before|after|when|how\s+long|how\s+many\s+days|which.*first)\b/.test(queryLower);
    const isComparative = /\b(which.*or)\b/.test(queryLower) || (/\bwhich\b/.test(queryLower) && /\bor\b/.test(queryLower));
    const isDuration = /\b(how\s+many\s+days|how\s+long)\b/.test(queryLower);

    const entities = this.extractQueryEntities(query);

    if (isTemporal) {
      let temporalType: 'sequence' | 'duration' | 'specific_time' | 'relative_time' = 'sequence';

      if (isDuration) {
        temporalType = 'duration';
      } else if (/\b(when|what\s+time|what\s+date)\b/.test(queryLower)) {
        temporalType = 'specific_time';
      } else if (/\b(before|after|since|until)\b/.test(queryLower)) {
        temporalType = 'relative_time';
      }

      return { type: 'temporal', temporalType, confidence: 0.9, entities };
    }

    if (isComparative) {
      return { type: 'comparative', confidence: 0.8, entities };
    }

    // Preference questions
    if (/\b(prefer|like|favorite|choose|recommendation)\b/.test(queryLower)) {
      return { type: 'preference', confidence: 0.8, entities };
    }

    return { type: 'factual', confidence: 0.6, entities };
  }

  private extractQueryEntities(query: string): string[] {
    // Same general extractor used at ingest time, so query and record entities align.
    const entities = this.extractEntities(query)
      .filter((entity) => entity.type !== 'PROBLEM' && entity.type !== 'TIME')
      .map((entity) => entity.text);
    return [...new Set(entities)];
  }

  async search(query: MemorySearchQuery): Promise<MemorySearchHit[]> {
    this.pruneExpired();
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100); // Increased default limit
    const minScore = query.minScore ?? 0.05; // Lowered threshold for better recall
    
    // Classify the query to guide retrieval strategy
    const queryClassification = await this.classifyQuery(query.query);
    
    // Generate query embedding for semantic similarity
    const queryEmbedding = await this.embeddingService.embed(query.query);
    
    const hits: MemorySearchHit[] = [];
    
    for (const record of this.records.values()) {
      if (record.status !== "active") continue;
      if (!this.matchesFilters(record, query.filters)) continue;
      
      const { score, reasons } = await this.computeEnhancedScore(
        record,
        query.query,
        queryEmbedding,
        queryClassification
      );
      
      if (score < minScore) continue;
      hits.push({ memory: record, score, reasons });
    }
    
    // Enhanced sorting with temporal awareness
    hits.sort((a, b) => {
      // For temporal queries, prioritize temporal relevance
      if (queryClassification.type === 'temporal') {
        const aTemporalRelevant = (a.memory as EnhancedMemoryRecord).temporalMetadata?.isTemporallyRelevant ?? false;
        const bTemporalRelevant = (b.memory as EnhancedMemoryRecord).temporalMetadata?.isTemporallyRelevant ?? false;
        
        if (aTemporalRelevant !== bTemporalRelevant) {
          return bTemporalRelevant ? 1 : -1;
        }
        
        // Within temporally relevant memories, sort by temporal order for sequence queries
        if (queryClassification.temporalType === 'sequence' && aTemporalRelevant && bTemporalRelevant) {
          const aOrder = (a.memory as EnhancedMemoryRecord).temporalMetadata?.temporalOrder ?? 0;
          const bOrder = (b.memory as EnhancedMemoryRecord).temporalMetadata?.temporalOrder ?? 0;
          return aOrder - bOrder;
        }
      }
      
      // Default to score-based sorting
      return b.score - a.score || b.memory.updatedAt.localeCompare(a.memory.updatedAt);
    });
    
    return hits.slice(0, limit);
  }

  private matchesFilters(record: EnhancedMemoryRecord, filters: MemoryFilters): boolean {
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

  private async computeEnhancedScore(
    record: EnhancedMemoryRecord,
    query: string,
    queryEmbedding: number[],
    queryClassification: { type: string; temporalType?: string; confidence: number; entities: string[] }
  ): Promise<{ score: number; reasons: string[] }> {
    const reasons: string[] = [];
    
    // Semantic similarity (using embeddings)
    let semantic = 0;
    if (record.embedding && queryEmbedding) {
      semantic = this.embeddingService.similarity(queryEmbedding, record.embedding);
      if (semantic > 0.7) reasons.push("high semantic similarity");
    }
    
    // Lexical similarity (fallback)
    const lexical = this.overlapScore(query, record.text);
    if (lexical > 0.4) reasons.push("high lexical overlap");
    
    // Recency score
    const recency = this.recencyScore(record.lastSeenAt);
    if (recency > 0.7) reasons.push("recent memory");
    
    // Confidence and importance
    const confidence = record.confidence;
    const importance = record.importance;
    if (confidence >= 0.75) reasons.push("high confidence");
    if (importance >= 0.75) reasons.push("high importance");
    
    // Feedback boost
    const feedbackDelta = record.stats.positiveCount - record.stats.negativeCount;
    const feedbackBoost = Math.max(Math.min(feedbackDelta * 0.02, 0.12), -0.12);
    if (feedbackBoost > 0.05) reasons.push("strong positive feedback");
    if (feedbackBoost < -0.05) reasons.push("negative feedback penalty");
    
    // Temporal relevance boost for temporal queries
    let temporalBoost = 0;
    if (queryClassification.type === 'temporal' && record.temporalMetadata?.isTemporallyRelevant) {
      temporalBoost = 0.3;
      reasons.push("temporally relevant for temporal query");
      
      // Extra boost for sequence queries if this has order information
      if (queryClassification.temporalType === 'sequence' && record.temporalMetadata.temporalOrder !== undefined) {
        temporalBoost += 0.2;
        reasons.push("has temporal ordering information");
      }
    }
    
    // Entity matching boost
    let entityBoost = 0;

    if (record.entityMetadata?.extractedEntities) {
      const queryEntities = queryClassification.entities.map(e => e.toLowerCase());
      const queryTokens = tokenize(query.toLowerCase());
      const entityMatches = record.entityMetadata.extractedEntities.filter(entity =>
        queryEntities.includes(entity.text.toLowerCase()) ||
        queryTokens.includes(entity.text.toLowerCase())
      );

      if (entityMatches.length > 0) {
        entityBoost = Math.min(entityMatches.length * 0.15, 0.4);
        reasons.push(`matches ${entityMatches.length} entities: ${entityMatches.map(e => e.text).join(', ')}`);
      }
    }

    let score: number;

    if (queryClassification.type === 'temporal') {
      // Temporal queries: prioritize temporal relevance and entity matching
      score = semantic * 0.3 + temporalBoost * 0.25 + entityBoost * 0.2 + lexical * 0.15 +
              recency * 0.05 + confidence * 0.03 + importance * 0.02 + feedbackBoost;
    } else if (queryClassification.type === 'comparative') {
      // Comparative queries: prioritize entity matching
      score = entityBoost * 0.4 + semantic * 0.3 + lexical * 0.2 +
              recency * 0.05 + confidence * 0.03 + importance * 0.02 + feedbackBoost;
    } else {
      // Factual queries: prioritize semantic similarity
      score = semantic * 0.4 + lexical * 0.25 + entityBoost * 0.2 +
              recency * 0.08 + confidence * 0.04 + importance * 0.03 + feedbackBoost;
    }

    return { score: Math.max(0, Math.min(1, score)), reasons };
  }

  private overlapScore(a: string, b: string): number {
    const ta = new Set(tokenize(a));
    const tb = new Set(tokenize(b));
    if (ta.size === 0 || tb.size === 0) return 0;

    let overlap = 0;
    for (const token of ta) {
      if (tb.has(token)) overlap++;
    }

    return overlap / Math.max(ta.size, tb.size);
  }

  private recencyScore(iso: string, halfLifeDays = 30): number {
    const ageMs = Date.now() - new Date(iso).getTime();
    const ageDays = Math.max(ageMs / (1000 * 60 * 60 * 24), 0);
    return Math.exp((-Math.log(2) * ageDays) / halfLifeDays);
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

  async getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null> {
    this.pruneExpired();
    const record = this.records.get(id);
    if (!record || record.status !== "active") return null;
    if (scope && (record.tenantId !== scope.tenantId || record.appId !== scope.appId)) return null;
    return record;
  }

  async applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null> {
    this.pruneExpired();
    const record = this.records.get(feedback.memoryId);
    if (!record || record.status !== "active") return null;
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

    record.lastSeenAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();
    this.records.set(record.id, record);
    return record;
  }

  async compact(): Promise<MemoryCompactResult> {
    const archivedExpired = this.pruneExpired();
    return { archivedExpired, archivedSuperseded: 0 };
  }

  /**
   * Context building over the enhanced retrieval path. Extractive only: every
   * line comes from a stored memory, nothing is synthesized.
   *
   * @deprecated Use `MemoryCoreService.buildContext`. This assembles prompt text
   * without going through the service, so it does not get the service's guards,
   * and this provider ranks near chance on public benchmarks (LongMemEval R@10
   * 0.125 against a 0.014 random floor). It has no callers outside its own test.
   */
  async buildEnhancedContext(query: string, filters: MemoryFilters, budget: { maxItems?: number }): Promise<{
    contextText: string;
    selectedMemories: Array<{
      id: string;
      memoryType: MemoryType;
      text: string;
      score: number;
      reasons: string[];
    }>;
  }> {
    const maxItems = budget?.maxItems ?? 20;
    const searchHits = await this.search({ query, filters, limit: maxItems });

    const contextLines = ["ENHANCED MEMORY SEARCH RESULTS:"];
    const selectedMemories = [];

    for (const hit of searchHits.slice(0, maxItems)) {
      // Same rule the service applies: text an extractor never rewrote or
      // grounded must not reach a prompt. An attacker can force that path by
      // inducing an unparsable model response, which stores the raw turn.
      if (hit.memory.source?.metadata?.extractionOrigin === "fallback") continue;
      contextLines.push(`- [${hit.memory.memoryType}] ${hit.memory.text} (score: ${hit.score.toFixed(3)})`);
      selectedMemories.push({
        id: hit.memory.id,
        memoryType: hit.memory.memoryType,
        text: hit.memory.text,
        score: hit.score,
        reasons: hit.reasons,
      });
    }

    return {
      contextText: contextLines.join('\n'),
      selectedMemories,
    };
  }

  async health() {
    return {
      ok: true,
      provider: "enhanced",
      detail: `records=${this.records.size}, episodes=${this.episodeMap.size}`,
    };
  }
}