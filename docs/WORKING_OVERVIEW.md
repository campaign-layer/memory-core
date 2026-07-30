# Working overview

How a request flows through the code, end to end. Verified against a running server.

The route table lives in the [README](../README.md#http-api); this file is the pipeline.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `src/http.ts` — Express 5 + zod, started by `src/server.ts` |
| MCP | `src/integrations/mcp-server.ts` — 6 tools, embedded or remote |
| SDK | `MemoryCoreClient` (`src/client.ts`), or `MemoryCoreService` in-process |
| Tool schemas | `toAnthropicTools()` / `toOpenAITools()` and adapters, from one zod source |

## Request pipeline

1. `express.json({limit: "2mb"})`.
2. Request-id middleware: echoes `x-request-id` or generates one, sets it on the response, and
   logs `method url status ms` on finish.
3. Rate limiter: fixed 60 s window keyed on API key, else `req.ip`. 429 with `Retry-After`.
4. `/v1/*` auth gate: if `MEMORY_CORE_API_KEYS` is non-empty, requires `x-api-key` or
   `Authorization: Bearer`. `/health` and `/ready` are never gated.
5. zod parse of the body. On failure, 400 `{message, errors:[{path, message}]}`.
6. `MemoryCoreService` → `MemoryProvider`.
7. Error middleware: any thrown error becomes 500 `{message}`.

## Write path

`MemoryCoreService.ingest`, per observation, **sequentially**:

1. Build a candidate record: `uid("mem")` id, identity from the request, and defaults —
   `scope: "actor"`, `confidence: 0.7`, `importance: 0.5`,
   `decayPolicy: {kind: "time", ttlDays: 180}`, `status: "active"`, zeroed feedback stats.
2. Normalize: collapse whitespace, truncate `text` to 1000 chars, derive `summary` if absent
   (first 117 chars + `...` when over 120), clamp `confidence` and `importance` to 0–1.
3. `provider.findDuplicate(candidate)` — **exact normalized-text equality** within the same
   actor and memory type.
4. If a duplicate exists: bump `lastSeenAt`/`updatedAt`, take the max of `confidence` and
   `importance`, keep the existing summary, shallow-merge metadata, `provider.update()`.
5. Otherwise `provider.ingest([candidate])`.

**What is not here:** no semantic dedupe, no contradiction detection, no supersession. Step 3
is the whole resolution stage, and because it is exact string equality, a revised fact is
stored alongside the stale one with both `active` and both permanently retrievable. This is
the measured cause of the knowledge-update failures in [`BENCHMARKS.md`](./BENCHMARKS.md).

**Extraction** sits in front of step 1 and is **off by default**. `MEMORY_EXTRACTOR=none`
selects a passthrough that turns each observation into exactly one fact with its text
unchanged, so the default write path is byte-identical to the pre-extraction behaviour.
`MEMORY_EXTRACTOR=llm` sends turns to an OpenAI-compatible chat endpoint to be distilled into
atomic statements first. **No benchmark on this project has been run with extraction on** —
see [`BENCHMARKS.md`](./BENCHMARKS.md#what-this-page-does-not-cover).

## Read path

`search`:

1. `filters.tenantId` and `filters.appId` are required — providers throw on an unscoped query.
2. Hard filters first: tenant, app, then optional actor, thread, memoryTypes, scope, metadata.
   These are applied *inside* each candidate scan, so scoping precedes ranking.
3. Decay-expired records are excluded lazily at read time.
4. Candidate generation. With no embedder configured this is BM25 alone; with one, BM25 and
   vector cosine run as two independent rankers and are fused by Reciprocal Rank Fusion
   (`rrfK` 5 in-process, 60 in Postgres).
5. Provider-specific re-weighting by recency, confidence, importance and feedback (formulas in
   [`providers.md`](./providers.md)). Scores are contractually 0–1.
6. Drop anything below `minScore` (provider-specific default), sort by score then `updatedAt`
   descending, slice to `limit` (max 100).

If the embedder throws at step 4, the in-process providers log once, disable it for a
cooldown, and fall back to the lexical path rather than failing the request.

There is **no reranking and no diversification** on this path — `src/retrieval/rerank.ts` and
`src/retrieval/mmr.ts` exist and are called by nothing. There is no multi-hop: one query, one
round of candidates.

`buildContext`:

1. Clamp the budget: `maxItems` 1–30 (default 8), `maxChars` 300–20000 (default 3000).
2. `search()` with `limit = maxItems * 2`.
3. Greedily take hits in score order until `maxItems` or `maxChars` is hit — **no diversity**,
   so several near-duplicates can consume the whole budget. Budget is counted in
   **characters, not tokens**.
4. If `filters.actorId` is set, `getProfile()` → `listByActor()`, which returns **every** record
   for that actor, unbounded, on every context build. Its `summary` takes the first 3 memories
   of each type by recency — not by relevance to the query.
5. Emit:

```
KNOWN ACTOR PROFILE:
Preferences:
- Prefers vegetarian Italian restaurants

RELEVANT MEMORIES:
- [preference] Prefers vegetarian Italian restaurants
```

Response fields: `profileSummary`, `selectedMemories[{id, memoryType, text, score, reasons}]`,
`contextText`, `totalMemories`, `processingTime` (real, from `performance.now()`).

## Feedback and lifecycle

- `POST /v1/memory/feedback` with `selected` | `positive` | `negative` increments a counter on
  the record. Providers turn `positive − negative` into a small clamped score nudge (±0.3 in
  in-memory, ±0.12 in dual-layer and postgres). That is the entire learning loop.
- `POST /v1/memory/compact` archives decay-expired records. `archivedSuperseded` is
  effectively always `0` because nothing on the write path sets that status.
- Decay kinds: `none`, `time` (age from creation), `inactivity` (age from `lastSeenAt`).

## Providers

`in-memory` (default), `file`, `enhanced` (deprecated), `dual-layer` (deprecated), `postgres`.
There is **no `mem0` provider** — earlier revisions of this file listed one; it has never
existed in this repo. mem0 appears in [`BENCHMARKS.md`](./BENCHMARKS.md) as a system we
measured against, not as a backend you can select.

See [`providers.md`](./providers.md) for storage, ranking formulas and measured quality.

## Security and runtime controls

- Optional API key auth on `/v1/*` via `MEMORY_CORE_API_KEYS`. **Keys are not scoped to a
  tenant** — any valid key can reach every tenant.
- Per-identity rate limit via `MEMORY_RATE_LIMIT_PER_MIN`, **per process** (so it is
  decorative behind more than one replica), and `trust proxy` is not enabled.
- No CORS policy and no security headers.
- Graceful shutdown on SIGINT/SIGTERM, closing the provider (pg pool, timers, pending writes).

Full gap list:
[`deployment.md`](./deployment.md#limits-to-know-before-you-deploy).
