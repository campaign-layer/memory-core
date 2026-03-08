export type MemoryType =
  | "fact"
  | "preference"
  | "goal"
  | "project"
  | "episode"
  | "tool_outcome"
  | "instruction"
  | "profile";

export type MemoryScope =
  | "thread"
  | "actor"
  | "workspace"
  | "app"
  | "tenant";

export type MemoryStatus = "active" | "superseded" | "archived";

export type DecayKind = "none" | "time" | "inactivity";

export interface DecayPolicy {
  kind: DecayKind;
  ttlDays?: number;
}

export interface MemorySource {
  sourceType: string;
  sourceId?: string | null;
  sourceSessionId?: string | null;
}

export interface MemoryFeedbackStats {
  selectedCount: number;
  positiveCount: number;
  negativeCount: number;
}

export interface MemoryRecord {
  id: string;
  tenantId: string;
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

export interface MemoryFilters {
  tenantId: string;
  appId: string;
  actorId?: string;
  threadId?: string;
  memoryTypes?: MemoryType[];
  scope?: MemoryScope[];
  metadata?: Record<string, string | number | boolean>;
}

export interface MemorySearchQuery {
  query: string;
  filters: MemoryFilters;
  limit?: number;
  minScore?: number;
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
  selectedMemories: Array<{
    id: string;
    memoryType: MemoryType;
    text: string;
    score: number;
    reasons: string[];
  }>;
  contextText: string;
}

export interface MemoryFeedbackInput {
  memoryId: string;
  signal: "selected" | "positive" | "negative";
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
