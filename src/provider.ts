import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryRecord,
  MemorySearchQuery,
  MemorySearchHit,
  MemoryFilters,
  ContextBuildResult,
} from "./types.js";

export interface ProviderHealthStatus {
  ok: boolean;
  provider: string;
  detail?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  provider?: string;
  details?: Record<string, any>;
}

export interface ContextBuildParams {
  query: string;
  filters: MemoryFilters;
  budget?: {
    maxItems?: number;
    maxChars?: number;
  };
}

export interface MemoryProvider {
  ingest(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null>;
  update(record: MemoryRecord): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]>;
  getById(id: string): Promise<MemoryRecord | null>;
  applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null>;
  compact(): Promise<MemoryCompactResult>;
  health?(): Promise<ProviderHealthStatus>;
  
  // Additional methods for new providers
  ingestObservations?(tenantId: string, observations: import('./types.js').MemoryObservation[]): Promise<void>;
  buildContext?(params: ContextBuildParams): Promise<ContextBuildResult>;
}
