import type {
  MemoryCompactResult,
  MemoryFeedbackInput,
  MemoryRecord,
  MemorySearchQuery,
  MemorySearchHit,
  MemoryFilters,
  ContextBuildResult,
  MemoryRetirementStatus,
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
 * Caller scope for id-addressed reads. Ids are globally unique, so without this
 * a caller holding an id could read or retire a record outside its visibility.
 */
export interface MemoryIdScope {
  tenantId: string;
  /** Preferred boundary for cross-agent access; defaults to actorId when present. */
  spaceId?: string;
  /** Legacy producer boundary, consulted only when spaceId is absent. */
  appId?: string;
  /** Required to address actor- or thread-scoped memory inside a shared space. */
  actorId?: string;
  /** Required to address thread-scoped memory inside a shared space. */
  accessThreadId?: string;
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
  /** Provider-stage score gate used when callers omit minScore. The service
   *  uses this to reconstruct exact fail-open behavior after wide reranking. */
  readonly defaultMinScore?: number;
  ingest(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null>;
  update(record: MemoryRecord): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  /** Returns records visible to this access context, newest first. */
  listVisible(filters: MemoryFilters, limit?: number): Promise<MemoryRecord[]>;
  listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]>;
  /** Pass `scope` whenever the id came from outside the process. */
  getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null>;
  /** Atomically retires an active id inside the caller's visibility boundary. */
  retire(
    id: string,
    status: MemoryRetirementStatus,
    metadataPatch: Record<string, unknown> | undefined,
    scope: MemoryIdScope,
  ): Promise<MemoryRecord | null>;
  applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null>;
  compact(): Promise<MemoryCompactResult>;
  health?(): Promise<ProviderHealthStatus>;
  /** Applies durable schema migrations during process initialization. */
  migrate?(): Promise<void>;
  /** Releases pools, timers, and pending writes. Called on server shutdown. */
  close?(): void | Promise<void>;

  // Additional methods for new providers
  ingestObservations?(tenantId: string, observations: import('./types.js').MemoryObservation[]): Promise<void>;
  buildContext?(params: ContextBuildParams): Promise<ContextBuildResult>;
}
