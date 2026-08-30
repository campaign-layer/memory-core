# Deployment

Running memory-core. Read
[Limits to know before you deploy](#limits-to-know-before-you-deploy) first.

Earlier revisions of this file documented CORS settings, `LOG_LEVEL`, `NODE_ENV`-driven
behaviour, winston logging, a `prom-client` `/metrics` endpoint, `FILE_BACKUP_*`,
`ENHANCED_*`, `DUAL_LAYER_*` variables, and `/v1/memory/export` + `/v1/memory/import` routes.
**None of those exist.** The lists below are exhaustive.

## Limits to know before you deploy

Not a certification — a gap list, re-checked against the code.

### Horizontal scaling

- **The rate limiter is per-process.** Three replicas means 3x the configured limit; use an
  upstream or distributed limiter when the quota must be fleet-wide.
- **Proxy headers are distrusted by default.** Behind a reverse proxy, set
  `MEMORY_TRUST_PROXY_HOPS` to the exact hop count or unauthenticated clients share the
  proxy's IP bucket. Setting it too high lets callers spoof their source address.
- **No idempotency keys on ingest.** A retried `POST /v1/memory/ingest` relies on exact-text
  dedupe, which fails the moment the text differs by one character.
- **Only `postgres` can back more than one replica.** `in-memory`, `file`, `enhanced` and
  `dual-layer` are process-local, and `file` actively corrupts under two writers.

### Auth

- **Authentication is optional only for the default loopback listener.** Normal agent credentials belong in
  `MEMORY_CORE_PRINCIPAL_API_KEYS`, which binds tenant, effective space, app, and actor.
  `MEMORY_CORE_TENANT_API_KEYS` is privileged tenant-admin/identity-assertor access, and
  every `MEMORY_CORE_API_KEYS` value is a global operator. Leaving all three empty disables
  authentication, but a non-loopback listener then fails startup unless the explicit
  development-only override is set. `MEMORY_ENV=production` always requires credentials.
  A principal can still select a thread within its bound actor.
- One per-key limit applies when auth is enabled, but there are no differentiated quotas,
  rotation, expiry, or audit log of memory reads and writes.
- Configured credentials are pre-hashed and looked up as fixed-width SHA-256 digests; there
  is no external secret manager or online rotation mechanism.
- Responses set `nosniff`, `DENY` frame, no-referrer, and no-store headers. There is still no
  CORS policy, CSP, or TLS termination; do not expose the service directly to a browser.
- JSON is parsed only after coarse IP limiting, authentication, and per-key limiting.
  Ingest is capped at 200 observations; text, summaries, identifiers, and metadata have
  independent schema bounds in addition to the 2 MiB body limit.

### Observability

- **No `/metrics` endpoint and no tracing.** Earlier docs advertised a Prometheus-compatible
  `/metrics` and `/admin/*`; neither exists and both return 404.
- `buildContext` returns a real `processingTime`, but nothing is aggregated or exported.
- Hybrid hits carry component scores; the lexical path returns prose `reasons` only.
- No SLOs, dashboards or alerts.

### Retrieval quality

Measured, not asserted — see [`BENCHMARKS.md`](./BENCHMARKS.md). The short version: mem0 beats
us on LoCoMo R@1/R@5/MRR/nDCG and on QA accuracy, a plain BM25 baseline beats us on
LongMemEval R@1, no system anywhere handles knowledge updates, the `postgres` provider has no
measured retrieval number at all, and the internal `buildContext` regression exposes weak
top-1 ordering, stale-over-current failures, and total abstention leakage. That context suite
is repository-authored and is not a public benchmark or a SOTA comparison.

### Reliability

- No dead-letter queue for failed ingest or update and no backpressure. Hosted embedder and
  reranker calls have local fail-open cooldowns, but there is no distributed coordination.
  Reranker counters/cooldown and Postgres vector-failure counts are available from the
  in-process health object, but the unauthenticated `/ready` route deliberately exposes only
  provider kind and boolean status. There is no authenticated fleet metrics surface yet.
- `service.ingest` loops observations sequentially; batch ingest is serial.
- `FileProvider.persist()` re-serializes every record on every write.
- `dual-layer`'s consolidation is O(n²) per actor on a 30 s timer, unbounded.
- SIGINT/SIGTERM stops accepting work and closes provider resources. A stuck HTTP drain is
  force-closed after 10 seconds; provider close receives a further five-second bound, and a
  forced or failed close exits non-zero for the orchestrator to record.

## Local self-hosting

There are two useful local topologies:

- **One agent, embedded MCP:** the MCP subprocess owns an in-memory or file provider. This is
  the shortest development path, but each MCP process is a separate service.
- **Several agents, one shared service:** run one memory-core HTTP process and point one MCP
  proxy per agent at it. This is the recommended topology for Claude, Codex, Hermes, or other
  agents sharing actor/workspace memory.

Do **not** point several embedded MCP processes at the same JSON file. The file provider is
single-process and has no inter-process lock. For a local multi-agent setup, one file-backed
HTTP service may safely be the sole writer; use Postgres for multiple service replicas or a
production-shaped deployment.

### Build a local checkout

Node 20 or newer is required.

```bash
npm ci
npm run build
```

For edit/reload development, `npm run dev` runs `tsx src/server.ts`. For a durable local
service, run the built JavaScript with `npm start`.

### Start one private service for Claude, Codex, and Hermes

Create the parent directory for `MEMORY_FILE_PATH`, then start exactly one process. Replace
the example keys before use:

```bash
export MEMORY_CORE_PRINCIPAL_API_KEYS='[
  {"key":"replace-claude-key","tenantId":"local","spaceId":"madhav-personal","appId":"claude","actorId":"madhav"},
  {"key":"replace-codex-key","tenantId":"local","spaceId":"madhav-personal","appId":"codex","actorId":"madhav"},
  {"key":"replace-hermes-key","tenantId":"local","spaceId":"madhav-personal","appId":"hermes","actorId":"madhav"}
]'

HOST=127.0.0.1 \
MEMORY_PROVIDER=file \
MEMORY_FILE_PATH=/absolute/path/to/memory-core-data/store.json \
npm start
```

The three grants intentionally share tenant, space, and actor while keeping distinct app ids
for provenance. Actor-scoped records can therefore follow the same person across agents;
app-scoped records remain with their producer. Use different actors or spaces when memories
must not cross that boundary.

Check the process before connecting an agent:

```bash
curl -s http://127.0.0.1:7401/ready
# {"ok":true,"service":"memory-core","provider":{"ok":true,"provider":"file"},...}
```

Then configure each agent as a **remote-mode stdio MCP proxy** using its own principal key.
The exact Claude, Codex, and Hermes configurations are in
[`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md#connect-local-agents-to-the-shared-service).

### Current security boundary

The configured binary now defaults to `HOST=127.0.0.1`. With no credentials it refuses a
non-loopback listener unless `MEMORY_ALLOW_INSECURE_LISTEN=true` is explicitly set in
development; that override emits a warning and is rejected when `MEMORY_ENV=production`.
Production mode additionally requires Postgres, an explicit database URL, credentials, and
application auto-migration disabled.

The TypeScript client rejects redirects and credentials embedded in the base URL, requires
HTTPS outside loopback, and enforces one deadline across the response body plus a 1 MiB
default body limit. Hosted embedder, reranker, and extractor requests apply the same
non-redirecting, bounded-body contract; their retries and clamped `Retry-After` sleeps share
one operation deadline.

Still terminate TLS and enforce network policy at a trusted proxy for any non-loopback
deployment. This startup contract prevents the easiest accidental exposure; it does not add
TLS, distributed rate limits, audit logs, or the remaining production gates above.

This is a safe local operating recipe, not a production-readiness claim.

### Local Postgres instead of a JSON file

Use the [docker-compose example](#docker-compose) when you want Postgres + pgvector locally.
Postgres is the only supported backend for more than one memory-core replica. For a
production-shaped installation, run migrations as a separate job, keep
`MEMORY_PG_AUTO_MIGRATE=false` on application replicas, and complete the backup/restore and
multi-replica gates listed above.

### Build output

`npm run build` compiles `src/**` to `dist/`. Tests are compiled too because `tsconfig.json`
does not exclude them, but the server never imports them and package artifacts exclude them.

## Configuration

Every environment variable the service reads, from `src/config.ts`. Process environments
contain unrelated keys, so unknown names cannot be rejected; validate the deployment manifest
and use `/ready` to confirm the selected provider kind.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `7401` | Must be 1–65535 or startup throws. |
| `HOST` | `127.0.0.1` | An unauthenticated non-loopback bind fails closed. |
| `MEMORY_ENV` | `development` | `development` \| `test` \| `production`. Production requires credentials, Postgres, an explicit database URL, and external migrations. This is intentionally independent of `NODE_ENV`. |
| `MEMORY_ALLOW_INSECURE_LISTEN` | `false` | Exactly `"true"` permits an unauthenticated non-loopback listener only outside production and emits a warning. |
| `MEMORY_PROVIDER` | `in-memory` | `in-memory` \| `file` \| `enhanced` \| `dual-layer` \| `postgres`. Anything else fails zod at startup. |
| `MEMORY_FILE_PATH` | `./data/memory-core.json` | `file` provider only. |
| `MEMORY_CORE_API_KEYS` | unset | Comma-separated **global operator** keys. Each can access every tenant and run compaction. |
| `MEMORY_CORE_TENANT_API_KEYS` | unset | JSON object from tenant id to privileged tenant-admin/identity-assertor keys. These may act as any actor in the tenant. |
| `MEMORY_CORE_PRINCIPAL_API_KEYS` | unset | Normal-agent grants: `[{"key":"agent-key","tenantId":"acme","spaceId":"team","appId":"planner","actorId":"alice"}]`; `spaceId` defaults to `actorId`. |
| `MEMORY_RATE_LIMIT_PER_MIN` | `120` | Must be 10–10000 or startup throws. Per identity, **per process**. |
| `MEMORY_TRUST_PROXY_HOPS` | unset | Trusted reverse-proxy hop count. Integer 1–10; unset trusts no forwarded address. |
| `MEMORY_PG_URL` | dev localhost URL | Postgres connection string. |
| `DATABASE_URL` | — | Fallback if `MEMORY_PG_URL` is unset. |
| `MEMORY_PG_AUTO_MIGRATE` | `false` | Exactly `"true"` verifies/applies checksummed migrations before the production listener opens. |
| `MEMORY_EMBEDDER` | `none` | `none` \| `local` \| `hash` \| `voyage` \| `openai`. `none` means BM25-only retrieval. |
| `MEMORY_EMBEDDING_MODEL` | unset | Model id override, and the label stored beside vectors. |
| `MEMORY_EMBEDDING_DIMS` | unset | Dimension override. Integer 1–16000 or startup throws. |
| `MEMORY_RERANKER` | `none` | `none` \| `voyage`. Applies a service-level cross-encoder after provider recall. |
| `MEMORY_RERANKER_MODEL` | `rerank-2.5` | Voyage model override. |
| `MEMORY_RERANKER_MIN_SCORE` | `0` | Final cross-encoder score gate in 0–1. Calibrate before raising. |
| `MEMORY_EXTRACTOR` | `none` | `none` (passthrough) \| `llm`. `none` keeps the write path byte-identical to pre-extraction behaviour. |
| `MEMORY_EXTRACTOR_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible chat endpoint. |
| `MEMORY_EXTRACTOR_API_KEY` | unset | Key for the above; the LLM extractor falls back to `OPENAI_API_KEY`. |
| `MEMORY_EXTRACTOR_MODEL` | `gpt-4o-mini` | Extraction model. |
| `MEMORY_EXTRACTOR_BATCH_SIZE` | unset | Turns per extraction call. Integer 1–200 or startup throws. |

The MCP server reads a separate set (`MEMORY_TENANT_ID`, `MEMORY_SPACE_ID`, `MEMORY_APP_ID`,
`MEMORY_ACTOR_ID`, `MEMORY_CORE_URL`, `MEMORY_CORE_API_KEY`, `MEMORY_CORE_MODE`, `MEMORY_THREAD_ID`,
`MEMORY_SOURCE_TYPE`) — see [`src/integrations/README.md`](../src/integrations/README.md).

`VOYAGE_API_KEY` is read when either the Voyage embedder or reranker is selected;
`OPENAI_API_KEY` is read by the OpenAI embedder.

The reranker is optional and fail-open: it pulls 50–100 provider candidates, returns the
requested top-k, and gates on `MEMORY_RERANKER_MIN_SCORE`. Each call is capped at five seconds
with no inline retry. A failure logs once, disables the hosted stage for 60 seconds, and
reuses the already-fetched provider ranking without a second provider request. In-process
`MemoryCoreService.getHealth()` exposes configured id, requests, attempts, successes,
failures, fallbacks, and cooldown; unauthenticated `/ready` does not.

**Turning on `MEMORY_EMBEDDER` changes cost, not just quality.** On the synthetic corpus
(527 records, one machine) `local` took ingest from 6 ms to 3.7 s and search from 0.11 ms to
6.2 ms mean. `local` downloads a ~35 MB ONNX model on first use and is offline thereafter;
`voyage` and `openai` add a network call per batch. `/ready` confirms the provider kind only;
record the resolved embedder and dimension from deployment configuration or the in-process
health object.

**`MEMORY_EXTRACTOR=llm` costs one model call per batch of turns** and has no measured
quality number. The default `none` is what every published benchmark for this project was
measured with.

## Docker

```bash
docker build -t memory-core .
docker run -p 127.0.0.1:7401:7401 \
  -e HOST=0.0.0.0 \
  -e MEMORY_CORE_API_KEYS=replace-operator-key \
  memory-core

# Optional local ONNX image. Do not release while its dependency audit is red.
docker build \
  --build-arg MEMORY_CORE_INCLUDE_LOCAL_ONNX=true \
  -t memory-core-local-onnx .

# file persistence (the image pre-creates /app/data owned by the node user)
docker run -p 127.0.0.1:7401:7401 \
  -e HOST=0.0.0.0 \
  -e MEMORY_CORE_API_KEYS=replace-operator-key \
  -e MEMORY_PROVIDER=file \
  -e MEMORY_FILE_PATH=/app/data/memory-core.json \
  -v "$(pwd)/data:/app/data" \
  memory-core

# postgres
docker run -p 127.0.0.1:7401:7401 \
  -e HOST=0.0.0.0 \
  -e MEMORY_CORE_API_KEYS=replace-operator-key \
  -e MEMORY_PROVIDER=postgres \
  -e MEMORY_PG_URL='postgres://user:pw@host:5432/memory_core' \
  -e MEMORY_PG_AUTO_MIGRATE=true \
  memory-core
```

The `Dockerfile` is three stages:

1. **build** — `npm ci --omit=optional` with devDependencies, then `npm run build`. tsc is a
   devDependency, while the local ONNX import is deliberately dynamic and is not needed to
   compile.
2. **prod-deps** — `npm ci --omit=dev --omit=optional` in a clean stage, so no `typescript`,
   `tsx`, `@types/express`, or native ONNX stack reaches the default runtime image. Set build
   argument `MEMORY_CORE_INCLUDE_LOCAL_ONNX=true` only for an explicitly audited local-ONNX
   image.
3. **runtime** — `node:22-bookworm-slim` holding only `dist/`, production `node_modules`,
   `package.json` and `migrations/`. Unprivileged `node` user, `/app/data` pre-created and
   chowned, a `HEALTHCHECK` using node's global `fetch` (no curl in the image), and an
   exec-form `CMD ["node", "dist/server.js"]` so SIGTERM reaches the process rather than being
   swallowed by npm.

Two things that are load-bearing:

- **`migrations/` must ship.** `PostgresMemoryProvider` resolves every pending versioned SQL
  file relative to its compiled location. Drop the COPY and `MEMORY_PG_AUTO_MIGRATE=true`
  fails at runtime.
- **The default image intentionally omits optional dependencies.** It supports BM25 plus
  Voyage/OpenAI embedders, but `MEMORY_EMBEDDER=local` needs the opt-in build argument. The
  optional native dependency tree currently has unresolved high-severity advisories and is
  not release-gated.
- **The base is Debian, not Alpine.** The opt-in ONNX stack pulls native `onnxruntime-node`
  and `sharp` binaries that target glibc.

The previous Dockerfile could not build at all: it ran `npm ci --only=production` and then
`npm run build`, with `typescript`, `@types/node` and `@types/express` in devDependencies.
CI now builds the default image without optional ONNX packages and boots that image against
`pgvector/pgvector:pg16`, asserting that `/ready` names the Postgres provider.

### docker-compose

The checked-in [`docker-compose.yml`](../docker-compose.yml) is an executable local-beta
stack: Postgres + pgvector, the memory-core image, a persistent volume, loopback-only host
publication, and separate demo credentials for Claude, Codex, and Hermes.

```bash
docker compose up --build -d
node examples/shared-agent-demo.mjs
docker compose down
```

The credentials in that file are public examples, not deployable secrets. Replace them before
non-local use. `docker compose down` preserves the named database volume; the stack deliberately
uses application auto-migration for a one-command local demo. Production must use external
migrations and `MEMORY_ENV=production`. `pgvector/pgvector:pg16` ships the extension. On a
plain `postgres` image the migration raises a notice and vector search stays disabled while
full-text search keeps working.

## Kubernetes

Only `MEMORY_PROVIDER=postgres` is safe with `replicas > 1`. The other four providers are
process-local; `file` will corrupt under two writers.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: memory-core
spec:
  replicas: 3
  selector:
    matchLabels: { app: memory-core }
  template:
    metadata:
      labels: { app: memory-core }
    spec:
      containers:
      - name: memory-core
        image: memory-core:latest
        ports: [{ containerPort: 7401 }]
        env:
        - { name: HOST, value: "0.0.0.0" }
        - { name: MEMORY_ENV, value: "production" }
        - { name: MEMORY_PROVIDER, value: "postgres" }
        - name: MEMORY_PG_URL
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: pg-url } }
        - name: MEMORY_CORE_API_KEYS
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: api-keys } }
        - name: MEMORY_CORE_TENANT_API_KEYS
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: tenant-api-keys } }
        - name: MEMORY_CORE_PRINCIPAL_API_KEYS
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: principal-api-keys } }
        resources:
          requests: { memory: "256Mi", cpu: "100m" }
          limits:   { memory: "1Gi",   cpu: "1000m" }
        livenessProbe:
          httpGet:  { path: /health, port: 7401 }
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          # /ready calls the provider's health(), so it fails when Postgres is unreachable.
          httpGet:  { path: /ready, port: 7401 }
          initialDelaySeconds: 5
          periodSeconds: 5
```

Use `/ready` for readiness and `/health` for liveness — that distinction matters here, because
`/health` is static and would keep a pod with a dead database in the load-balancer pool.

Run the migration as a `Job` rather than relying on `MEMORY_PG_AUTO_MIGRATE` with three
replicas racing each other. It is idempotent, but a single ordered application is cleaner.

The memory-space upgrade backfills legacy rows into each record owner's personal space. This
is intentionally privacy-preserving but narrows old `app`/`workspace` sharing. Before rollout,
back up the database and explicitly update `space_id` for legacy records that should remain in
a shared team space. The migration does not guess that policy.

`terminationGracePeriodSeconds` defaults to 30 s, which exceeds memory-core's 10-second HTTP
drain plus five-second provider-close bound.

## Behind a proxy

- Set `MEMORY_TRUST_PROXY_HOPS` to the exact number of trusted hops between the client and
  memory-core. Leave it unset for direct connections. Do not use an arbitrarily high value:
  Express would then trust a caller-controlled forwarded address.
- The per-process limiter multiplies by replica count. With three replicas and
  `MEMORY_RATE_LIMIT_PER_MIN=120`, the real ceiling is 360/min.
- Terminate TLS at the proxy; the service speaks plain HTTP only.
- Baseline hardening headers are emitted, but there is no CORS policy, CSP, or TLS. Keep the
  service on an internal network behind the proxy.

## Health and observability

```bash
curl -s localhost:7401/health
# {"ok":true,"service":"memory-core","timestamp":"2026-07-29T06:25:29.888Z"}

curl -s localhost:7401/ready
# {"ok":true,"service":"memory-core",
#  "provider":{"ok":true,"provider":"in-memory"},
#  "timestamp":"..."}
```

That is the whole observability surface. There is no `/metrics`, no `/admin/*`, no tracing and
no structured logging — the HTTP layer writes one line per request to `console.log`:

```
[memory-core] <request-id> POST /v1/memory/context 200 3ms
```

Safe `x-request-id` values (`[A-Za-z0-9._:-]`, at most 128 characters) are echoed, so they can
correlate with an upstream trace id; other values are replaced. Access logs deliberately omit
query strings because search queries can contain private memory. Collect stdout; there is no
log file and no log-level control.

## Auth

```bash
export MEMORY_CORE_PRINCIPAL_API_KEYS='[{"key":"acme-agent-key","tenantId":"acme","appId":"agent-app","actorId":"alice"}]'
export MEMORY_CORE_API_KEYS=operator-key

curl -H "x-api-key: acme-agent-key" \
  'localhost:7401/v1/memory/search?q=launch&tenantId=acme&appId=agent-app&actorId=alice'
curl -H "Authorization: Bearer operator-key" localhost:7401/v1/memory/compact -X POST
```

Only `/v1/*` requires authentication. Health and readiness bypass auth and both admission
limiters so orchestrator probes cannot be starved. Configured keys are compared as
fixed-width SHA-256 digests. Principal keys receive 403 before provider access when tenant,
effective space, app, or actor differs; tenant-wide writes require a tenant-admin or global
key. Tenant-admin keys may assert any actor in their tenant, including mixed application
identities, so reserve them for trusted gateways. Compaction is store-wide and requires a
global operator key. Startup rejects a credential shared across operator, tenant-admin, and
principal grant classes. If all three key settings are empty, authentication is disabled.
There is still no built-in rotation, expiry, distributed quota, or durable audit log.

## Backup

- **`file`** — copy `MEMORY_FILE_PATH` while the process is idle. Every write rewrites the
  whole file, so a copy taken mid-write can be truncated.
- **`postgres`** — `pg_dump`. Embeddings live in `memory_embeddings_<dims>` tables alongside
  `memories`; include them or plan to re-embed.
- **`in-memory`, `enhanced`, `dual-layer`** — nothing to back up; state is lost on restart.

There is no export or import route.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Invalid enum value` at startup | `MEMORY_PROVIDER` is not one of the five kinds. |
| `Invalid PORT value` / `Invalid MEMORY_RATE_LIMIT_PER_MIN value` | Out of range. Rate limit must be 10–10000. |
| Env var seems ignored | zod strips unknown keys. Only the variables in the table above are read. |
| 401 on `/v1/*` | Authentication is enabled and the presented key is missing or unknown. |
| 403 on `/v1/*` | The key is valid but the requested principal exceeds its grant, or a non-operator attempted global compaction. |
| 429 | Rate limit. Check `Retry-After`. Remember it is per process. |
| `/ready` 503 | Provider `health()` failed — usually Postgres unreachable. |
| `postgres-provider: pgvector is not installed` | `CREATE EXTENSION vector;` in the target database. |
| `postgres-provider: … requires both tenantId and appId` | An unscoped query. Intentional. |
| Vector search is lexical-only on `postgres` | Check `/ready` and logs for pgvector/table/embedder degradation. Provision the configured dimension during deploy; request paths never run DDL. |
| Container exits immediately | Check `docker logs`. A zod config error throws before the listener starts. |
| Search returns nothing | `minScore` defaults differ per provider (0.05, 0.1, 0.2). Pass `minScore: 0`. |
| `archivedSuperseded` stays 0 | Expected unless an explicit supersede flow marked records before compaction; there is no automatic Resolver. |
