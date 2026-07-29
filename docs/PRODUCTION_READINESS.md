# Production readiness

Current state, re-checked against the code. **Nothing here has run in production.** Treat
this as a gap list, not a certification.

## In place, and verified

| Item | Detail |
|---|---|
| HTTP service | Express 5, `src/http.ts`. One log line per request with an `x-request-id` (echoed from the caller or generated). |
| Liveness / readiness | `GET /health` (static) and `GET /ready` (calls the provider's `health()`, returns 503 if unhealthy). Both unauthenticated by design. |
| Input validation | zod on every memory endpoint. 400 with `{message, errors:[{path, message}]}`. `MEMORY_TYPES` in `http.ts` is kept in lockstep with the `MemoryType` union by a `satisfies` + `AssertNever` pair, so adding a type without listing it fails the build. |
| API key auth | `MEMORY_CORE_API_KEYS`, comma-separated. Gates `/v1/*` only. Accepts `x-api-key` or `Authorization: Bearer`. |
| Rate limiting | `MEMORY_RATE_LIMIT_PER_MIN` (default 120), fixed 60 s window keyed on API key then `req.ip`. Sends `Retry-After` on 429. Sweeps stale buckets past 10k entries. |
| Provider abstraction | `in-memory`, `file`, `enhanced`, `dual-layer`, `postgres`. Validated by zod at startup. |
| Durable store | `PostgresMemoryProvider` + `migrations/001_init.sql`: tsvector FTS, pgvector HNSW, RRF fusion in SQL, nine partial indexes, parameterized throughout. |
| Graceful shutdown | `src/server.ts` handles SIGINT/SIGTERM, stops accepting connections, then `await provider.close?.()` to release the pg pool, timers and pending writes. Verified: the compiled server exits cleanly on SIGTERM. |
| Tenant scope enforcement | `in-memory`, `dual-layer` and `postgres` all throw on a search missing `tenantId`/`appId` rather than returning everything. |
| Memory lifecycle | Decay policies (`none` / `time` / `inactivity`, default `time` 180 days), lazy expiry on read, and `POST /v1/memory/compact`. |
| SDK client | `MemoryCoreClient` (`src/client.ts`) covering every route. |
| Agent surface | MCP server with 6 tools, embedded + remote modes, both verified end-to-end over stdio including a restart-persistence check. See [`src/integrations/README.md`](../src/integrations/README.md). |
| Tests | `npm test` — 98 tests, 97 pass, 1 skipped (ONNX, gated behind `RETRIEVAL_ONNX_TEST`), 0 fail. `npm run test:pg` covers the Postgres provider against a real database. |
| Retrieval eval harness | `bench/` with a random control, a BM25 baseline, a plain-RAG control, and a live third-party comparison. See [`BENCHMARKS.md`](./BENCHMARKS.md). |
| Container build | Multi-stage `Dockerfile`, unprivileged `node` user, healthcheck, exec-form CMD so signals reach the process. |

Corrections to the previous version of this file: it listed `mem0` as an available provider
(no such provider has ever existed here) and listed "add `PgVectorProvider`" as an open gap
(it is now built).

## Blocking gaps

### 1. Horizontal scaling is unsafe

- **The rate limiter is per-process.** Three replicas means 3x the configured limit. It is
  decorative behind a load balancer.
- **`trust proxy` is not enabled.** Behind any reverse proxy, `req.ip` is the proxy's address,
  so every unauthenticated client shares one bucket — the limiter either blocks everyone or
  no one. Enable `app.set("trust proxy", ...)` before fronting this with a proxy.
- **No idempotency keys on ingest.** A retried `POST /v1/memory/ingest` relies on exact-text
  dedupe to avoid duplicates, which fails the moment the text differs by a character.
- **`in-memory`, `file`, `enhanced` and `dual-layer` are all process-local.** Only `postgres`
  can back more than one replica. `file` will actively corrupt under two writers.

### 2. Auth is coarse

- **API keys are not scoped to a tenant.** Any valid key can read and write **every** tenant.
  Multi-tenancy is enforced against accidents, not against a hostile caller holding a key.
- No per-key rate limits, no key rotation, no expiry, no audit log of memory reads/writes.
- Keys are compared with a `Set.has()` string match — not constant-time.
- No CORS policy and no security headers (no `cors`, no `helmet`). Do not expose this
  directly to a browser.
- The only request-size control is `express.json({ limit: "2mb" })`.

### 3. Observability is thin

- **No `/metrics` endpoint and no tracing.** Earlier docs advertised a Prometheus-compatible
  `/metrics` and `/admin/*` routes; none of them exist and all return 404.
- `buildContext` does return a real `processingTime` (from `performance.now()`), but nothing
  is aggregated, exported or alertable.
- `reasons: string[]` on each hit is human-readable prose, not component scores. Only
  `HybridRetriever` and the Postgres provider expose per-stage numbers, and `HybridRetriever`
  is not on the request path. You cannot answer "why was this ranked first" for the default
  provider.
- No SLOs, dashboards or alerts.

### 4. Retrieval quality is the real gap

Measured, not asserted — see [`BENCHMARKS.md`](./BENCHMARKS.md):

- **A plain BM25 baseline beats every provider on `R@10` (92.0% vs 89.8% best).** Nothing here
  currently earns its complexity over lexical matching on that dataset.
- **Every system fails knowledge-update**, including the live third-party system we compared
  against. `findDuplicate` compares exact normalized text, so a revised fact is stored next to
  the stale one with both `active` and both retrievable forever. This is the single biggest
  quality gap and it is a write-path problem.
- **`archivedSuperseded` is always 0.** `MemoryStatus` includes `superseded` and
  `DecayPolicy` exists, but nothing on the write path ever sets it — only the `supersede` MCP
  tool does.
- **No extraction.** The API accepts pre-formed memory statements, so a caller must pre-digest
  raw conversation. Agents that dump raw turns in get raw turns back out.
- **`buildContext` is unmeasured**, and it is the endpoint agents actually call. It prepends a
  profile built from `listByActor()` — an unbounded full actor scan on every request — selects
  greedily in score order with no diversity, and budgets in **characters, not tokens** (off by
  roughly 4x, model-dependent).
- **The `postgres` provider has no measured retrieval number at all.** It is not registered as
  a bench system.

### 5. No CI, no release gates

- No `.github/`, no pipeline. `npm test`, `npm run typecheck` and the bench harness all run
  only when someone remembers.
- **`npm run bench:typecheck` currently fails** (exit 2, 157 errors, all in `src/**`):
  `bench/tsconfig.json` sets `noUncheckedIndexedAccess: true` and includes `../src/**/*.ts`,
  which the root `tsconfig.json` does not. Either reconcile the two configs or scope the bench
  config to `bench/`.
- **`node_modules` is tracked in git** — 1,540 files, despite `node_modules/` being in
  `.gitignore`. Needs `git rm -r --cached node_modules`.
- **No LICENSE file.** `package.json` is `private: true` with no `license` field, so this is
  not currently licensed for redistribution.
- `examples/*.js` import `axios`, which is not a dependency, so they do not run.

### 6. Reliability

- No dead-letter queue for failed ingest/update, no backpressure, no circuit breakers.
- `service.ingest` loops observations sequentially, awaiting a `findDuplicate` per
  observation. Batch ingest is serial.
- `FileProvider.persist()` re-serializes every record on every write — O(N²) disk writes to
  load a dataset.
- `dual-layer`'s consolidation is O(n²) per actor on a 30 s timer, unbounded, and its caches
  evict only expired keys.

## Ordered path forward

Retrieval quality first: an operationally perfect service that returns the wrong memory is
not useful.

1. **Resolver on the write path** — semantic dedupe, refine, contradict, real supersession.
   Fixes knowledge-update, the one family everything fails.
2. **Register `postgres` in `bench/`** so the durable backend has a measured number before
   anyone deploys it.
3. **Reconcile the two tsconfigs** and stand up CI running `typecheck`, `test`,
   `bench:typecheck` and `bench:small` with the random control asserted.
4. **`ContextBuilder` v2** — token-aware budgeting, MMR diversity, structured sections, a
   ranked-and-capped profile instead of a full actor scan.
5. **Scoped auth + audit log** — bind each key to a tenant, log every memory read and write.
6. **Distributed rate limiting**, `trust proxy`, and idempotency keys on ingest.
7. **Telemetry** — per-stage spans and component scores on every hit, exported.

Items 1 and 4 are detailed with effort estimates in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#sequencing).

## Comparison to hosted memory services

One same-harness comparison exists: `supermemory`, run through `bench/` against the same
corpus. We tie on `R@10` and `R@1` and **lose on mid-rank ordering** (`R@5` 62.5% vs 80.7%,
`MRR` 0.615 vs 0.662, `nDCG@10` 0.648 vs 0.688). Full numbers and caveats in
[`BENCHMARKS.md`](./BENCHMARKS.md).

No other system has been run through this harness, so no other comparison is supportable.
Capability gaps against that class of product, stated as gaps rather than measurements:

1. Hybrid retrieval on the default path (we have the primitives; only `postgres` fuses).
2. A reranker over the top-k candidates (the interface exists; no implementation is wired).
3. Extraction from raw conversation turns.
4. Managed operations — backups, migrations, multi-region, an SLA.
