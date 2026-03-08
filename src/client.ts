import type {
  ContextBuildRequest,
  ContextBuildResult,
  MemoryFeedbackInput,
  MemoryFilters,
  MemoryIngestRequest,
  MemoryProfile,
  MemorySearchHit,
  MemorySearchQuery,
} from "./types.js";

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

  getProfile(tenantId: string, appId: string, actorId: string) {
    return this.request<MemoryProfile>(`/v1/memory/profile/${tenantId}/${appId}/${actorId}`);
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

  searchByQueryParams(query: string, filters: MemoryFilters, limit?: number, minScore?: number) {
    const url = new URL(`${this.baseUrl}/v1/memory/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("tenantId", filters.tenantId);
    url.searchParams.set("appId", filters.appId);
    if (filters.actorId) url.searchParams.set("actorId", filters.actorId);
    if (filters.threadId) url.searchParams.set("threadId", filters.threadId);
    if (filters.memoryTypes?.length) url.searchParams.set("types", filters.memoryTypes.join(","));
    if (typeof limit === "number") url.searchParams.set("limit", String(limit));
    if (typeof minScore === "number") url.searchParams.set("minScore", String(minScore));

    return this.request<{ count: number; hits: MemorySearchHit[] }>(url.pathname + url.search);
  }
}
