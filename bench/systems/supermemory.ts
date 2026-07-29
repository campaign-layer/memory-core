/**
 * supermemory live-API adapter.
 *
 * NOT TESTED AGAINST THE LIVE SERVICE — no SUPERMEMORY_API_KEY was available when this
 * was written. Built strictly from the published OpenAPI document at
 * https://api.supermemory.ai/v4/openapi (title "supermemory API", OpenAPI 3.1.0) and
 * the docs at https://supermemory.ai/docs — no endpoint here is invented. Endpoints used:
 *
 *   POST /v4/memories  "Create memories directly, bypassing the document ingestion
 *                       workflow. Generates embeddings and makes them immediately
 *                       searchable."  -> 201 { documentId, memories: [{ id, memory, ... }] }
 *   POST /v4/search    "Search memory entries"
 *                      -> 200 { results: [{ id, memory?, chunk?, similarity, metadata }], timing, total }
 *   DELETE /v3/documents/bulk   best-effort teardown by container tag
 *
 * /v4/memories is chosen over /v3/documents on purpose: /v3/documents ingestion is
 * asynchronous ("returns immediately with status: 'queued'... wait until done before
 * searching"), which would silently measure indexing lag as retrieval failure.
 *
 * Score field naming differs by API version: /v3/search returns `score` + `documentId`,
 * /v4/search returns `similarity` + `id`. This adapter targets v4 only.
 */
import {
  SkipSystem,
  type BenchSystem, type MaterializedMemory, type RankedHit,
} from "../types.js";

const DEFAULT_BASE_URL = "https://api.supermemory.ai";
/** Documented default for POST /v4/search is 0.6; that is supermemory's own gate. */
const DOCUMENTED_THRESHOLD = 0.6;
const MAX_MEMORIES_PER_CALL = 100;

interface SupermemorySearchResult {
  id: string;
  memory?: string;
  chunk?: string;
  similarity: number;
  metadata?: Record<string, unknown> | null;
}

export interface SupermemoryOptions {
  /** Container tag scoping this run. Charset restricted to [A-Za-z0-9_-], max 100 chars. */
  containerTag: string;
}

export function createSupermemorySystem(options: SupermemoryOptions): BenchSystem {
  const baseUrl = (process.env.SUPERMEMORY_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const searchMode = process.env.SUPERMEMORY_SEARCH_MODE ?? "hybrid";
  const batchSize = Math.min(
    MAX_MEMORIES_PER_CALL,
    Math.max(1, Number(process.env.SUPERMEMORY_BATCH_SIZE ?? "25")),
  );
  const requestDelayMs = Math.max(0, Number(process.env.SUPERMEMORY_REQUEST_DELAY_MS ?? "150"));
  const containerTag = (process.env.SUPERMEMORY_CONTAINER_TAG ?? options.containerTag)
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .slice(0, 100);

  let apiKey = "";
  /** supermemory memory id -> our corpus id, in case metadata round-trip is lossy. */
  const remoteToBenchId = new Map<string, string>();
  const textToBenchId = new Map<string, string>();

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function call(pathname: string, method: string, body?: unknown): Promise<any> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** attempt);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}${pathname}`, {
          method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${method} ${pathname} -> ${res.status} ${await res.text()}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`${method} ${pathname} -> ${res.status} ${await res.text()}`);
      }
      if (res.status === 204) return null;
      return await res.json();
    }
    throw lastError ?? new Error(`${method} ${pathname} failed`);
  }

  return {
    name: "supermemory",
    note: `live API ${baseUrl} /v4 (searchMode=${searchMode}, containerTag=${containerTag})`,
    defaultMinScore: DOCUMENTED_THRESHOLD,
    networkBound: true,

    async setup() {
      apiKey = process.env.SUPERMEMORY_API_KEY ?? "";
      if (!apiKey) {
        throw new SkipSystem("SUPERMEMORY_API_KEY not set, skipping");
      }
    },

    async ingest(memories: MaterializedMemory[]) {
      for (const m of memories) textToBenchId.set(m.text, m.id);

      for (let i = 0; i < memories.length; i += batchSize) {
        const batch = memories.slice(i, i + batchSize);
        const payload = {
          containerTag,
          memories: batch.map((m) => ({
            content: m.text,
            metadata: {
              benchId: m.id,
              sessionId: m.sessionId,
              memoryType: m.memoryType,
            },
          })),
        };
        const res = await call("/v4/memories", "POST", payload);
        for (const created of (res?.memories ?? []) as Array<{ id: string; memory?: string }>) {
          const benchId = created.memory ? textToBenchId.get(created.memory) : undefined;
          if (benchId) remoteToBenchId.set(created.id, benchId);
        }
        if (requestDelayMs > 0) await sleep(requestDelayMs);
      }
    },

    async search(query: string, k: number): Promise<RankedHit[]> {
      const res = await call("/v4/search", "POST", {
        q: query,
        containerTag,
        limit: Math.min(100, k),
        // Explicit 0: we want the full ranking. The docs' own default (0.6) is applied
        // later as supermemory's "system gate" so ranking and gating stay separable.
        threshold: 0,
        searchMode,
        rerank: false,
      });

      const hits: RankedHit[] = [];
      for (const r of (res?.results ?? []) as SupermemorySearchResult[]) {
        const fromMetadata = r.metadata?.["benchId"];
        const benchId =
          (typeof fromMetadata === "string" ? fromMetadata : undefined) ??
          remoteToBenchId.get(r.id) ??
          (r.memory ? textToBenchId.get(r.memory) : undefined) ??
          (r.chunk ? textToBenchId.get(r.chunk.trim()) : undefined);
        // Unmappable results are dropped rather than guessed; the count is reported.
        if (benchId) hits.push({ id: benchId, score: r.similarity });
      }
      // Deduplicate: hybrid mode can return a memory and a chunk of the same source.
      const best = new Map<string, number>();
      for (const h of hits) {
        const prev = best.get(h.id);
        if (prev === undefined || h.score > prev) best.set(h.id, h.score);
      }
      return [...best.entries()]
        .map(([id, score]) => ({ id, score }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, k);
    },

    async teardown() {
      if (!apiKey) return;
      try {
        await call("/v3/documents/bulk", "DELETE", { containerTags: [containerTag] });
      } catch {
        // Best effort: leftover data is scoped to this run's container tag.
      }
    },
  };
}
