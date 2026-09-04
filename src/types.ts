export type MemoryType =
  | "fact"
  | "preference"
  | "goal"
  | "project"
  | "episode"
  | "tool_outcome"
  | "instruction"
  | "profile"
  | "pattern"
  | "summary";

export type MemoryScope =
  | "thread"
  | "actor"
  | "workspace"
  | "app"
  | "tenant";

export type MemoryStatus = "active" | "superseded" | "archived";
export type MemoryRetirementStatus = Exclude<MemoryStatus, "active">;

export type DecayKind = "none" | "time" | "inactivity";

export interface DecayPolicy {
  kind: DecayKind;
  ttlDays?: number;
}

export interface MemorySource {
  sourceType: string;
  sourceId?: string | null;
  sourceSessionId?: string | null;
  metadata?: Record<string, any>;
}

export interface MemoryFeedbackStats {
  selectedCount: number;
  positiveCount: number;
  negativeCount: number;
  accessCount?: number;
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
  /**
   * Authorized sharing boundary inside a tenant. Unlike appId, this remains
   * stable when the same actor moves between Codex, Hermes, OpenClaw, or another
   * producer. Personal callers default it to actorId; teams should set an
   * explicit workspace id.
   */
  spaceId: string;
  /** Producer application. This is provenance, not the general read boundary. */
  appId: string;
  actorId: string;
  threadId?: string | null;
  scope: MemoryScope;
  memoryType: MemoryType;
  text: string;
  summary?: string | null;
  metadata: Record<string, unknown>;
  confidence: number;
  importance: number;
  status: MemoryStatus;
  source: MemorySource;
  decayPolicy: DecayPolicy;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  stats: MemoryFeedbackStats;
}

export interface MemoryObservation {
  tenantId: string;
  /** Defaults to actorId for a personal cross-agent memory space. */
  spaceId?: string;
  appId: string;
  actorId: string;
  threadId?: string | null;
  memoryType: MemoryType;
  scope?: MemoryScope;
  text: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  source: MemorySource;
  confidence?: number;
  importance?: number;
  decayPolicy?: DecayPolicy;
  observedAt?: string;
}

export interface MemoryIngestRequest {
  observations: MemoryObservation[];
}

export interface MemoryIngestResponse {
  success: boolean;
  recordsCreated: number;
  recordsUpdated: number;
}

/** One guarded correction of an existing memory. The caller identity is part
 * of the request because the id is opaque and globally unique. */
export interface MemorySupersedeRequest {
  memoryId: string;
  newText: string;
  reason?: string | null;
  tenantId: string;
  spaceId?: string;
  appId: string;
  actorId: string;
  accessThreadId?: string;
  source: MemorySource;
  /** Producer metadata for the replacement. Lifecycle linkage is added by the service. */
  metadata?: Record<string, unknown>;
}

export interface MemorySupersedeResult {
  updated: boolean;
  failure?: "not_found" | "identical" | "raced" | "provider_error";
  /** True only when replacement and retirement committed as one provider operation. */
  atomic?: boolean;
  previous?: MemoryRecord;
  replacement?: MemoryRecord;
  /** False when the replacement reused an already-active exact duplicate. */
  created?: boolean;
  /** Only legacy providers without an atomic replacement primitive can report this. */
  partial?: boolean;
}

export interface MemoryFilters {
  tenantId: string;
  /** Defaults to actorId, then appId for legacy app-wide callers. */
  spaceId?: string;
  appId: string;
  actorId?: string;
  /** Current caller thread for thread-scope visibility; does not filter broader memories. */
  accessThreadId?: string;
  /** Optional source-thread constraint retained for direct search callers. */
  threadId?: string;
  memoryTypes?: MemoryType[];
  scope?: MemoryScope[];
  metadata?: Record<string, string | number | boolean>;
}

export interface MemorySearchQuery {
  query: string;
  filters: MemoryFilters;
  limit?: number;
  /** Minimum first-stage provider score. */
  minScore?: number;
  /** Optional independent cross-encoder score threshold. */
  rerankerMinScore?: number;
}

export interface MemorySearchRequest {
  query: string;
  filters: MemoryFilters;
  limit?: number;
  /** Minimum first-stage provider score. */
  minScore?: number;
  /** Optional independent cross-encoder score threshold. */
  rerankerMinScore?: number;
}

export interface MemorySearchResponse {
  hits: MemorySearchHit[];
  totalCount: number;
  processingTime: number;
}

export interface MemorySearchHit {
  memory: MemoryRecord;
  score: number;
  reasons: string[];
}

export interface ContextBuildRequest {
  query: string;
  filters: MemoryFilters;
  budget?: {
    maxItems?: number;
    maxChars?: number;
  };
}

export interface ContextBuildResult {
  profileSummary: string;
  /** Profile records actually emitted in contextText. Added without changing the
   *  legacy profileSummary field, so every prompt line can be traced to an id. */
  profileMemories?: Array<{
    id: string;
    memoryType: MemoryType;
    text: string;
    provenance: ContextMemoryProvenance;
  }>;
  selectedMemories: Array<{
    id: string;
    memoryType: MemoryType;
    text: string;
    score: number;
    reasons: string[];
    provenance?: ContextMemoryProvenance;
  }>;
  contextText: string;
  totalMemories: number;
  /** Verified search/profile candidates considered but not emitted, usually because
   *  maxItems or maxChars could not admit a complete evidence line. */
  omittedCandidateCount?: number;
  processingTime: number;
  actorProfile?: string;
}

export interface ContextMemoryProvenance {
  observedAt: string;
  lastSeenAt: string;
  sourceType: string;
  sourceId?: string | null;
  sourceSessionId?: string | null;
}

export interface MemoryFeedbackInput {
  memoryId: string;
  signal: "selected" | "positive" | "negative";
  /** Tenant scope for the target memory. Optional for backward compatibility;
   *  providers that support it restrict the update to this scope, and the HTTP
   *  feedback route requires a complete caller identity. */
  tenantId?: string;
  /** Preferred id-addressed sharing boundary; defaults to actorId when present. */
  spaceId?: string;
  /** Legacy producer boundary, used only when spaceId is absent. */
  appId?: string;
  /** Caller actor for scope-aware id authorization. */
  actorId?: string;
  /** Caller thread for scope-aware id authorization. */
  accessThreadId?: string;
}

export interface MemoryCompactResult {
  archivedExpired: number;
  archivedSuperseded: number;
}

export interface MemoryProfile {
  tenantId: string;
  appId: string;
  actorId: string;
  summary: string;
  byType: Record<MemoryType, string[]>;
  count: number;
}
