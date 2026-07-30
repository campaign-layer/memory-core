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

- **The rate limiter is per-process.** Three replicas means 3x the configured limit. It is
  decorative behind a load balancer.
- **`trust proxy` is not enabled.** Behind any reverse proxy `req.ip` is the proxy's address,
  so every unauthenticated client shares one bucket and the limiter blocks everyone or no one.
  Enabling it needs a code change in `src/http.ts`.
- **No idempotency keys on ingest.** A retried `POST /v1/memory/ingest` relies on exact-text
  dedupe, which fails the moment the text differs by one character.
- **Only `postgres` can back more than one replica.** `in-memory`, `file`, `enhanced` and
  `dual-layer` are process-local, and `file` actively corrupts under two writers.

### Auth

- **API keys are not scoped to a tenant.** Any valid key reads and writes **every** tenant.
  Multi-tenancy is enforced against accidents, not against a hostile caller holding a key.
- No per-key rate limits, no rotation, no expiry, no audit log of memory reads or writes.
- Keys are compared with `Set.has()` — not constant-time.
- No CORS policy and no security headers. Do not expose this directly to a browser.
- The only request-size control is `express.json({ limit: "2mb" })`.

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
measured retrieval number at all, and `buildContext` — the endpoint agents actually call — is
unmeasured.

### Reliability

- No dead-letter queue for failed ingest or update, no backpressure, no circuit breakers.
- `service.ingest` loops observations sequentially; batch ingest is serial.
- `FileProvider.persist()` re-serializes every record on every write.
- `dual-layer`'s consolidation is O(n²) per actor on a 30 s timer, unbounded.

## Local

```bash
npm install
npm run dev            # tsx src/server.ts, hot reload, 0.0.0.0:7401
```

## Built

```bash
npm run build          # tsc -> dist/
npm start              # node dist/server.js
```

`npm run build` compiles `src/**` (tests included — `tsconfig.json` has no test exclusion, so
`dist/` contains `*.test.js`; they are never imported by the server).

## Configuration

Every environment variable the service reads, from `src/config.ts`. Unknown keys are stripped
by zod, so a typo is silently ignored — check `/ready` to confirm which provider actually
started.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `7401` | Must be 1–65535 or startup throws. |
| `HOST` | `0.0.0.0` | |
| `MEMORY_PROVIDER` | `in-memory` | `in-memory` \| `file` \| `enhanced` \| `dual-layer` \| `postgres`. Anything else fails zod at startup. |
| `MEMORY_FILE_PATH` | `./data/memory-core.json` | `file` provider only. |
| `MEMORY_CORE_API_KEYS` | unset | Comma-separated. When set, `/v1/*` requires `x-api-key` or `Authorization: Bearer`. Empty means **no auth**. |
| `MEMORY_RATE_LIMIT_PER_MIN` | `120` | Must be 10–10000 or startup throws. Per identity, **per process**. |
| `MEMORY_PG_URL` | dev localhost URL | Postgres connection string. |
| `DATABASE_URL` | — | Fallback if `MEMORY_PG_URL` is unset. |
| `MEMORY_PG_AUTO_MIGRATE` | `false` | Exactly the string `"true"` enables it. |
| `MEMORY_EMBEDDER` | `none` | `none` \| `local` \| `hash` \| `voyage` \| `openai`. `none` means BM25-only retrieval. |
| `MEMORY_EMBEDDING_MODEL` | unset | Model id override, and the label stored beside vectors. |
| `MEMORY_EMBEDDING_DIMS` | unset | Dimension override. Integer 1–16000 or startup throws. |
| `MEMORY_EXTRACTOR` | `none` | `none` (passthrough) \| `llm`. `none` keeps the write path byte-identical to pre-extraction behaviour. |
| `MEMORY_EXTRACTOR_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible chat endpoint. |
| `MEMORY_EXTRACTOR_API_KEY` | unset | Key for the above. |
| `MEMORY_EXTRACTOR_MODEL` | `gpt-4o-mini` | Extraction model. |
| `MEMORY_EXTRACTOR_BATCH_SIZE` | unset | Turns per extraction call. Integer 1–200 or startup throws. |

The MCP server reads a separate set (`MEMORY_TENANT_ID`, `MEMORY_APP_ID`, `MEMORY_ACTOR_ID`,
`MEMORY_CORE_URL`, `MEMORY_CORE_API_KEY`, `MEMORY_CORE_MODE`, `MEMORY_THREAD_ID`,
`MEMORY_SOURCE_TYPE`) — see [`src/integrations/README.md`](../src/integrations/README.md).

`VOYAGE_API_KEY` and `OPENAI_API_KEY` are read by the corresponding embedder classes when
`MEMORY_EMBEDDER` selects them.

**Turning on `MEMORY_EMBEDDER` changes cost, not just quality.** On the synthetic corpus
(527 records, one machine) `local` took ingest from 6 ms to 3.7 s and search from 0.11 ms to
6.2 ms mean. `local` downloads a ~35 MB ONNX model on first use and is offline thereafter;
`voyage` and `openai` add a network call per batch. Confirm what started with `/ready` — the
`detail` string names the resolved embedder and its dimension.

**`MEMORY_EXTRACTOR=llm` costs one model call per batch of turns** and has no measured
quality number. The default `none` is what every published benchmark for this project was
measured with.

## Docker

```bash
docker build -t memory-core .
docker run -p 7401:7401 memory-core

# file persistence (the image pre-creates /app/data owned by the node user)
docker run -p 7401:7401 \
  -e MEMORY_PROVIDER=file \
  -e MEMORY_FILE_PATH=/app/data/memory-core.json \
  -v "$(pwd)/data:/app/data" \
  memory-core

# postgres
docker run -p 7401:7401 \
  -e MEMORY_PROVIDER=postgres \
  -e MEMORY_PG_URL='postgres://user:pw@host:5432/memory_core' \
  -e MEMORY_PG_AUTO_MIGRATE=true \
  memory-core
```

The `Dockerfile` is three stages:

1. **build** — `npm ci` with devDependencies, then `npm run build`. tsc is a devDependency, so
   this stage must have them.
2. **prod-deps** — `npm ci --omit=dev` in a clean stage, so no `typescript`, `tsx` or
   `@types/express` reaches the runtime image.
3. **runtime** — `node:22-bookworm-slim` holding only `dist/`, production `node_modules`,
   `package.json` and `migrations/`. Unprivileged `node` user, `/app/data` pre-created and
   chowned, a `HEALTHCHECK` using node's global `fetch` (no curl in the image), and an
   exec-form `CMD ["node", "dist/server.js"]` so SIGTERM reaches the process rather than being
   swallowed by npm.

Two things that are load-bearing:

- **`migrations/` must ship.** `PostgresMemoryProvider` resolves the migration file relative to
  its own compiled location (`dist/providers/../../migrations/001_init.sql`). Drop the COPY and
  `MEMORY_PG_AUTO_MIGRATE=true` fails at runtime.
- **The base is Debian, not Alpine.** `@huggingface/transformers` is a runtime dependency and
  pulls in `onnxruntime-node` and `sharp`, whose prebuilt binaries are glibc-linked. On
  musl they install and then fail at require time.

The previous Dockerfile could not build at all: it ran `npm ci --only=production` and then
`npm run build`, with `typescript`, `@types/node` and `@types/express` in devDependencies.

### docker-compose

```yaml
services:
  memory-core:
    build: .
    ports: ["7401:7401"]
    environment:
      MEMORY_PROVIDER: postgres
      MEMORY_PG_URL: postgres://memory:memory@db:5432/memory_core
      MEMORY_PG_AUTO_MIGRATE: "true"
      MEMORY_CORE_API_KEYS: ${MEMORY_CORE_API_KEYS}
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped

  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: memory
      POSTGRES_PASSWORD: memory
      POSTGRES_DB: memory_core
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U memory"]
      interval: 5s
      retries: 10

volumes:
  pgdata:
```

`pgvector/pgvector:pg16` ships the extension. On a plain `postgres` image the migration raises
a notice and vector search stays disabled while full-text search keeps working.

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
        - { name: MEMORY_PROVIDER, value: "postgres" }
        - name: MEMORY_PG_URL
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: pg-url } }
        - name: MEMORY_CORE_API_KEYS
          valueFrom: { secretKeyRef: { name: memory-core-secrets, key: api-keys } }
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

`terminationGracePeriodSeconds` defaults to 30 s, which is comfortably more than the shutdown
path needs (stop listening, then close the pg pool).

## Behind a proxy

- **Enable `trust proxy` first.** It is not set, so `req.ip` is the proxy's address and every
  unauthenticated caller shares one rate-limit bucket. This needs a code change in
  `src/http.ts`.
- The per-process limiter multiplies by replica count. With three replicas and
  `MEMORY_RATE_LIMIT_PER_MIN=120`, the real ceiling is 360/min.
- Terminate TLS at the proxy; the service speaks plain HTTP only.
- There is no CORS policy and no security headers. Do not expose this directly to a browser.

## Health and observability

```bash
curl -s localhost:7401/health
# {"ok":true,"service":"memory-core","timestamp":"2026-07-29T06:25:29.888Z"}

curl -s localhost:7401/ready
# {"ok":true,"service":"memory-core",
#  "provider":{"ok":true,"provider":"in-memory","detail":"records=0, indexed=0"},
#  "timestamp":"..."}
```

That is the whole observability surface. There is no `/metrics`, no `/admin/*`, no tracing and
no structured logging — the HTTP layer writes one line per request to `console.log`:

```
[memory-core] <request-id> POST /v1/memory/context 200 3ms
```

`x-request-id` is echoed from the caller when present, so it correlates with an upstream trace
id. Collect stdout; there is no log file and no log-level control.

## Auth

```bash
export MEMORY_CORE_API_KEYS=key1,key2,key3
curl -H "x-api-key: key1"           localhost:7401/v1/memory/compact -X POST
curl -H "Authorization: Bearer key1" localhost:7401/v1/memory/compact -X POST
```

Only `/v1/*` is gated. Keys are **not scoped to a tenant** — any valid key reaches every
tenant — and comparison is not constant-time. There is no key rotation, expiry, per-key limit,
or audit log.

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
| `filePath is required when MEMORY_PROVIDER=file` | `MEMORY_FILE_PATH` unset and no default resolved. |
| 401 on `/v1/*` | `MEMORY_CORE_API_KEYS` is set and the key does not match. |
| 429 | Rate limit. Check `Retry-After`. Remember it is per process. |
| `/ready` 503 | Provider `health()` failed — usually Postgres unreachable. |
| `postgres-provider: pgvector is not installed` | `CREATE EXTENSION vector;` in the target database. |
| `postgres-provider: … requires both tenantId and appId` | An unscoped query. Intentional. |
| Vector search returns nothing on `postgres` | Expected via env config: no embedder is injected, so the provider is FTS-only. Construct `PostgresMemoryProvider` with an `embedder`. See [`providers.md`](./providers.md#postgres). |
| Container exits immediately | Check `docker logs`. A zod config error throws before the listener starts. |
| Search returns nothing | `minScore` defaults differ per provider (0.05, 0.1, 0.2). Pass `minScore: 0`. |
| `archivedSuperseded` always 0 | Correct. Nothing on the write path sets that status. |
