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
  MemorySupersedeRequest,
  MemorySupersedeResult,
} from "./types.js";
import type { MemoryIdScope } from "./provider.js";

export interface MemoryCoreClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Whole-operation deadline, including response-body parsing. Default 10 seconds. */
  timeoutMs?: number;
  /** Maximum response body accepted before parsing. Default 1 MiB. */
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export class MemoryCoreHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: ErrorOptions) {
    super(`memory-core request failed: ${message}`, options);
    this.name = "MemoryCoreHttpError";
    this.status = status;
  }
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "[::1]"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new TypeError("memory-core baseUrl must be an absolute URL", { cause });
  }
  if (url.username || url.password) {
    throw new TypeError("memory-core baseUrl must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new TypeError("memory-core baseUrl must not contain a query string or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new TypeError("memory-core baseUrl must use HTTPS except for loopback development");
  }
  return url.toString().replace(/\/+$/, "");
}

function boundedInteger(value: number | undefined, fallback: number, name: string, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > max) {
    throw new RangeError(`${name} must be an integer in 1..${max}`);
  }
  return resolved;
}

async function readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error("memory-core returned an invalid JSON response", { cause });
  }
}

export class MemoryCoreClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: MemoryCoreClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs", 120_000);
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
      16 * 1024 * 1024,
    );
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    headers.set("content-type", "application/json");
    if (this.apiKey) headers.set("x-api-key", this.apiKey);

    const controller = new AbortController();
    const deadlineError = new Error(`memory-core request deadline exceeded after ${this.timeoutMs}ms`);
    let deadlineTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        controller.abort(deadlineError);
        reject(deadlineError);
      }, this.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
      ]);
      let body: unknown;
      try {
        body = await Promise.race([readJsonBody(response, this.maxResponseBytes), deadline]);
      } catch (cause) {
        // A legacy server or proxy may return an HTML/plain-text 404. Preserve
        // the HTTP status so adapters can safely fall back without treating a
        // malformed successful response as valid JSON.
        if (!response.ok) {
          throw new MemoryCoreHttpError(response.status, `HTTP ${response.status}`, { cause });
        }
        throw cause;
      }
      if (!response.ok) {
        const message = body && typeof body === "object" && "message" in body
          ? String((body as { message?: unknown }).message || `HTTP ${response.status}`)
          : `HTTP ${response.status}`;
        throw new MemoryCoreHttpError(response.status, message);
      }
      return body as T;
    } catch (error) {
      // Native fetch/body streams may surface their own AbortError before the
      // deadline promise wins the race. Keep the public failure deterministic.
      if (timedOut) throw deadlineError;
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      controller.abort();
    }
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

  supersedeMemory(input: MemorySupersedeRequest) {
    return this.request<MemorySupersedeResult>("/v1/memory/supersede", {
      method: "POST",
      body: JSON.stringify(input),
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
