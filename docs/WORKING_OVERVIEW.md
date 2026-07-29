# Working overview

What the code currently does, end to end. Verified against a running server.

## Surfaces

| Surface | Entry point |
|---|---|
| REST | `src/http.ts` — Express 5 + zod, started by `src/server.ts` |
| MCP | `src/integrations/mcp-server.ts` — 6 tools, embedded or remote |
| SDK | `MemoryCoreClient` (`src/client.ts`), or `MemoryCoreService` in-process |
| Tool schemas | `toAnthropicTools()` / `toOpenAITools()` and adapters, from one zod source |

## HTTP routes

| Method | Route | Returns |
|---|---|---|
| `GET` | `/health` | `{ok, service, timestamp}` — liveness, unauthenticated |
| `GET` | `/ready` | `{ok, service, provider:{ok, provider, detail}, timestamp}`; 503 if the provider is unhealthy |
| `POST` | `/v1/memory/ingest` | `{created, updated, records[]}` |
| `POST` | `/v1/memory/search` | `{count, hits:[{memory, score, reasons[]}]}` |
| `GET` | `/v1/memory/search?q=&tenantId=&appId=&…` | same shape as POST |
| `POST` | `/v1/memory/context` | `{profileSummary, selectedMemories[], contextText, totalMemories, processingTime}` |
| `GET` | `/v1/memory/profile/:tenantId/:appId/:actorId` | `{tenantId, appId, actorId, byType, summary, count}` |
| `POST` | `/v1/memory/feedback` | `{updated}` |
| `POST` | `/v1/memory/compact` | `{archivedExpired, archivedSuperseded}` |

There is no `/metrics`, no `/admin/*`, no `/v1/memory/export` and no `/v1/memory/import`.
Earlier docs listed all of those; they return 404.

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

**What is not here:** no extraction from raw turns, no semantic dedupe, no contradiction
detection, no supersession. Step 3 is the whole resolution stage, and because it is exact
string equality, a revised fact is stored alongside the stale one with both `active` and both
permanently retrievable. This is the measured cause of the knowledge-update failures in
[`BENCHMARKS.md`](./BENCHMARKS.md).

## Read path

`search`:

1. `filters.tenantId` and `filters.appId` are required — providers throw on an unscoped query.
2. Hard filters first: tenant, app, then optional actor, thread, memoryTypes, scope, metadata.
3. Decay-expired records are excluded lazily at read time.
4. Provider-specific ranking (formulas in [`providers.md`](./providers.md)). Scores are
   contractually 0–1.
5. Drop anything below `minScore` (provider-specific default), sort by score then `updatedAt`
   descending, slice to `limit` (max 100).

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

`in-memory` (default), `file`, `enhanced`, `dual-layer`, `postgres`. There is **no `mem0`
provider** — earlier revisions of this file listed one; it has never existed in this repo.

See [`providers.md`](./providers.md) for storage, ranking formulas and measured quality.
`enhanced` is the worst-measured real provider and is not recommended.

## Security and runtime controls

- Optional API key auth on `/v1/*` via `MEMORY_CORE_API_KEYS`. **Keys are not scoped to a
  tenant** — any valid key can reach every tenant.
- Per-identity rate limit via `MEMORY_RATE_LIMIT_PER_MIN`, **per process** (so it is
  decorative behind more than one replica), and `trust proxy` is not enabled.
- No CORS policy and no security headers.
- Graceful shutdown on SIGINT/SIGTERM, closing the provider (pg pool, timers, pending writes).

Full gap list: [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md).
