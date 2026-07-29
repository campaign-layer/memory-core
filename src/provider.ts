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

/**
 * Tenant scope for id-addressed reads. Ids are globally unique, so without this
 * a caller holding an id from another tenant can read or retire that record.
 */
export interface MemoryIdScope {
  tenantId: string;
  appId: string;
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
  /** Pass `scope` whenever the id came from outside the process. */
  getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null>;
  applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null>;
  compact(): Promise<MemoryCompactResult>;
  health?(): Promise<ProviderHealthStatus>;
  /** Releases pools, timers, and pending writes. Called on server shutdown. */
  close?(): void | Promise<void>;
  
  // Additional methods for new providers
  ingestObservations?(tenantId: string, observations: import('./types.js').MemoryObservation[]): Promise<void>;
  buildContext?(params: ContextBuildParams): Promise<ContextBuildResult>;
}
