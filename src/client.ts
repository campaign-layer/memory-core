import type {
  ContextBuildRequest,
  ContextBuildResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryIngestRequest,
  MemoryProfile,
  MemoryRecord,
  MemoryRetirementStatus,
  MemorySearchHit,
  MemorySearchQuery,
} from "./types.js";
import type { MemoryIdScope } from "./provider.js";

interface MemoryCoreClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class MemoryCoreClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: MemoryCoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("x-api-key", this.apiKey);

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.message || `HTTP ${response.status}`;
      throw new Error(`memory-core request failed: ${message}`);
    }

    return body as T;
  }

  ingest(input: MemoryIngestRequest) {
    return this.request<{ created: number; updated: number; records: unknown[] }>(
      "/v1/memory/ingest",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  search(input: MemorySearchQuery) {
    return this.request<{ count: number; hits: MemorySearchHit[] }>("/v1/memory/search", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  buildContext(input: ContextBuildRequest) {
    return this.request<ContextBuildResult>("/v1/memory/context", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  getMemory(memoryId: string, scope: MemoryIdScope) {
    return this.request<{ memory: MemoryRecord | null }>("/v1/memory/get", {
      method: "POST",
      body: JSON.stringify({ ...scope, memoryId }),
    }).then((result) => result.memory);
  }

  retireMemory(
    memoryId: string,
    status: MemoryRetirementStatus,
    metadata: Record<string, unknown> | undefined,
    scope: MemoryIdScope,
  ) {
    return this.request<{ updated: boolean; record?: MemoryRecord }>("/v1/memory/status", {
      method: "POST",
      body: JSON.stringify({ ...scope, memoryId, status, metadata }),
    });
  }

  getProfile(tenantId: string, appId: string, actorId: string, spaceId?: string, threadId?: string) {
    const params = new URLSearchParams();
    if (spaceId) params.set("spaceId", spaceId);
    if (threadId) params.set("threadId", threadId);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<MemoryProfile>(
      `/v1/memory/profile/${encodeURIComponent(tenantId)}/${encodeURIComponent(appId)}/${encodeURIComponent(actorId)}${query}`,
    );
  }

  applyFeedback(input: MemoryFeedbackInput) {
    return this.request<{ updated: boolean }>("/v1/memory/feedback", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  compact() {
    return this.request<{ archivedExpired: number; archivedSuperseded: number }>(
      "/v1/memory/compact",
      {
        method: "POST",
      },
    );
  }

  searchByQueryParams(
    query: string,
    filters: MemoryFilters,
    limit?: number,
    minScore?: number,
    rerankerMinScore?: number,
  ) {
    const params = new URLSearchParams();
    params.set("q", query);
    params.set("tenantId", filters.tenantId);
    if (filters.spaceId) params.set("spaceId", filters.spaceId);
    params.set("appId", filters.appId);
    if (filters.actorId) params.set("actorId", filters.actorId);
    if (filters.accessThreadId) params.set("accessThreadId", filters.accessThreadId);
    if (filters.threadId) params.set("threadId", filters.threadId);
    if (filters.memoryTypes?.length) params.set("types", filters.memoryTypes.join(","));
    if (typeof limit === "number") params.set("limit", String(limit));
    if (typeof minScore === "number") params.set("minScore", String(minScore));
    if (typeof rerankerMinScore === "number") {
      params.set("rerankerMinScore", String(rerankerMinScore));
    }

    return this.request<{ count: number; hits: MemorySearchHit[] }>(`/v1/memory/search?${params.toString()}`);
  }
}
