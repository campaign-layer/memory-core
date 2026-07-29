# memory-core

An HTTP + MCP memory service for AI agents: ingest observations, retrieve them by query,
and build a prompt-ready context block. Pluggable storage backends (in-memory, JSON file,
Postgres + pgvector) behind one provider interface.

Pre-1.0 and honest about it. Retrieval quality is measured by a harness in this repo
([`bench/`](bench/README.md)) and the results are not flattering — see
[Retrieval quality](#retrieval-quality) below. The design gaps behind those numbers, and the
plan for them, are written up in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What it does

- **Store** typed memories (`fact`, `preference`, `goal`, `project`, `episode`,
  `tool_outcome`, `instruction`, `profile`, `pattern`, `summary`) scoped by
  tenant / app / actor / thread.
- **Retrieve** them by query with hard filters applied before ranking.
- **Build context** — one text block of a profile summary plus ranked memories, budgeted by
  item count and character count.
- **Expose all of that to agents** over REST, an MCP server with 6 tools, and
  Anthropic/OpenAI tool-schema exports. See
  [`src/integrations/README.md`](src/integrations/README.md).

## What it does not do

- **No extraction.** The API takes already-formed memory statements. Dumping raw
  conversation turns in will store raw turns.
- **No automatic resolution or supersession.** Duplicate detection is exact normalized-text
  equality. "I live in Lisbon" and "I moved to Berlin" both persist as active and
  retrievable. Supersession exists only as an explicit `supersede` MCP tool call.
- **No reranking or multi-hop on the request path.** `src/retrieval/` contains BM25,
  embedders, RRF, MMR and a `HybridRetriever`, but only BM25 (in-memory/file provider) and
  the embedder interface (Postgres provider) are wired in so far.
- **Nothing here has run in production.** Rate limiting is per-process, there is no CI, and
  no distributed store is the default.

## Quick start

```bash
git clone <this repo>
cd memory-core
npm install
npm run dev              # tsx src/server.ts, listens on 0.0.0.0:7401
```

Verified against a running server (`MEMORY_PROVIDER=in-memory`, the default):

```bash
curl -s localhost:7401/health
# {"ok":true,"service":"memory-core","timestamp":"..."}

curl -s localhost:7401/ready
# {"ok":true,"service":"memory-core","provider":{"ok":true,"provider":"in-memory",
#  "detail":"records=0, indexed=0"},"timestamp":"..."}

# Ingest. tenantId, appId, actorId, memoryType, text and source are all REQUIRED;
# text must be at least 4 characters.
curl -s -X POST localhost:7401/v1/memory/ingest \
  -H 'content-type: application/json' \
  -d '{"observations":[{
        "tenantId":"demo","appId":"chatbot","actorId":"user123",
        "memoryType":"preference",
        "text":"Prefers vegetarian Italian restaurants",
        "source":{"sourceType":"chat"},
        "confidence":0.9,"importance":0.8}]}'
# {"created":1,"updated":0,"records":[{...}]}

# Build context. filters.tenantId and filters.appId are REQUIRED.
curl -s -X POST localhost:7401/v1/memory/context \
  -H 'content-type: application/json' \
  -d '{"query":"restaurant recommendation",
       "filters":{"tenantId":"demo","appId":"chatbot","actorId":"user123"},
       "budget":{"maxItems":10,"maxChars":2000}}'
# {"profileSummary":"Preferences:\n- Prefers vegetarian Italian restaurants",
#  "selectedMemories":[{"id":"mem_...","memoryType":"preference","text":"...",
#    "score":0.97,"reasons":["strong term match","recent memory",...]}],
#  "contextText":"KNOWN ACTOR PROFILE:\n...\n\nRELEVANT MEMORIES:\n- [preference] ...",
#  "totalMemories":1,"processingTime":0.567}
```

From TypeScript:

```typescript
import { MemoryCoreClient } from "./src/client.js";

const memory = new MemoryCoreClient({ baseUrl: "http://localhost:7401" });

await memory.ingest({
  observations: [{
    tenantId: "demo",
    appId: "chatbot",
    actorId: "user123",
    memoryType: "preference",
    text: "Prefers vegetarian Italian restaurants",
    source: { sourceType: "chat" },
    confidence: 0.9,
    importance: 0.8,
  }],
});

const context = await memory.buildContext({
  query: "Recommend a restaurant",
  filters: { tenantId: "demo", appId: "chatbot", actorId: "user123" },
  budget: { maxItems: 10, maxChars: 2000 },
});
console.log(context.contextText);
```

## Retrieval quality

> **Read this before quoting any number below.** These come from
> `memory-core-internal-retrieval` v1.0.0 — a **synthetic dataset authored inside this
> repository**. 50 items / 527 memories / 17 sessions, seed 1337, six task families.
>
> **It is NOT LongMemEval. It is NOT LoCoMo.** It is not any published suite. These numbers
> are **not comparable** to published scores on those benchmarks and must never be presented
> as if they were. **LongMemEval has never been run in this repo.** A prior README claimed
> 27.9% on it; that claim was invalid (the provider hardcoded that benchmark's gold answers)
> and has been deleted.
>
> The corpus is generated from sentence templates. It measures whether a retriever ranks the
> right memory above vocabulary-sharing distractors. It says nothing about natural-language
> variety, real user phrasing, long documents, or end-to-end answer quality.
>
> **The dataset is ours, which is a real limitation.** A corpus we authored could
> unintentionally favour our own systems. Treat cross-system gaps here as a hypothesis to
> confirm on an external suite, not as a result.

Reproduce (every number in this section comes from exactly these two commands):

```bash
npx tsx bench/run.ts --systems=random,bm25,in-memory,file,enhanced,dual-layer,naive-rag --size=small --k=10
npx tsx bench/run.ts --systems=supermemory --size=small --k=10   # needs SUPERMEMORY_API_KEY
```

Provenance: dataset `memory-core-internal-retrieval` v1.0.0, hash `8c0cbec5d2f8aded`, seed
1337, size `small`, corpus 527 memories, retrieval depth 100, n = 44 answerable queries
(+ 6 unanswerable, scored separately), embedder `src:hash-bow-512`, git
`7f90586`. All eight rows come from one harness, one corpus, one metric definition — every
system goes through the same `ingest → search` path.

| system | R@1 | R@5 | R@10 | allGold@10 | MRR | nDCG@10 | meanRank | foundRate |
|---|---|---|---|---|---|---|---|---|
| random (control) | 0.0% | 1.1% | 1.1% | 0.0% | 0.017 | 0.009 | 407.2 | 25.0% |
| **bm25** (lexical baseline) | 34.1% | 67.0% | **92.0%** | 86.4% | 0.587 | 0.633 | 3.3 | 100.0% |
| in-memory | 40.9% | 62.5% | 89.8% | 84.1% | 0.615 | 0.648 | 3.6 | 100.0% |
| file | 40.9% | 62.5% | 89.8% | 84.1% | 0.615 | 0.648 | 3.6 | 100.0% |
| enhanced | 13.6% | 31.8% | 38.6% | 36.4% | 0.250 | 0.258 | 222.4 | 59.1% |
| dual-layer | 39.8% | 70.5% | 78.4% | 75.0% | 0.605 | 0.616 | 4.2 | 100.0% |
| naive-rag | 0.0% | 33.0% | 51.1% | 47.7% | 0.149 | 0.214 | 17.7 | 100.0% |
| supermemory (live API) | 40.9% | **80.7%** | 89.8% | 86.4% | **0.662** | **0.688** | 38.0 | 93.2% |

`random` is a seeded-shuffle control and is always run. The closed-form baseline for this
corpus is `E[R@10] = 1.9%`, `E[meanRank] = 423.9`, `E[MRR] = 0.0115`.

### What this actually shows, including where we lose

**1. A plain BM25 lexical baseline wins on `R@10` (92.0%).** Nothing in this repo currently
earns its complexity over Okapi BM25 with no recency, no priors, no embeddings, on this
dataset. That is the headline finding.

**2. The `enhanced` provider is the worst real system.** `R@10` 38.6% — it fails to return
the correct memory anywhere in the top 100 for 41% of queries (`foundRate` 59.1%), and its
`meanRank` of 222 on a 527-memory corpus is closer to the random control than to BM25. It
retrieves the right memory for knowledge-update questions **0% of the time**. It is also
~34x slower than in-memory. An earlier README called it "Production Ready"; it is not, and
it is not the provider to pick.

**3. Against live supermemory we tie on the ends and lose in the middle.** Same `R@10`
(89.8%) and same `R@1` (40.9%), but supermemory is better at mid-rank ordering:
`R@5` 80.7% vs 62.5%, `MRR` 0.662 vs 0.615, `nDCG@10` 0.688 vs 0.648. For an agent that
splices the top 5 into a prompt, that gap is the one that matters, and it is theirs.

**4. Every system fails knowledge-update. This is an open problem, not a solved one.**
`staleRate` = a superseded memory outranking the current one (lower is better), n = 8:

| system | knowledge-update R@10 | staleRate |
|---|---|---|
| bm25 | 100.0% | 100% |
| in-memory / file | 100.0% | 62.5% |
| dual-layer | 62.5% | 100% |
| supermemory | 100.0% | 100% |
| naive-rag | 50.0% | 62.5% |
| enhanced | **0.0%** | 12.5% |

Both records are ingested `active`; detecting the update is the system's job. `enhanced`'s
low `staleRate` is **not a win** — it never retrieves the correct memory at all, so there is
nothing for a stale record to outrank. Supermemory fails this family too.

### Per-family `R@10`

| system | single-hop (12) | multi-session (8) | temporal (10) | knowledge-update (8) | preference (6) |
|---|---|---|---|---|---|
| random | 0.0% | 6.3% | 0.0% | 0.0% | 0.0% |
| bm25 | 100.0% | 68.8% | 90.0% | 100.0% | 100.0% |
| in-memory / file | 100.0% | 68.8% | 80.0% | 100.0% | 100.0% |
| enhanced | 66.7% | 37.5% | 40.0% | 0.0% | 33.3% |
| dual-layer | 100.0% | 81.3% | 70.0% | 62.5% | 66.7% |
| naive-rag | 100.0% | 18.8% | 40.0% | 50.0% | 16.7% |
| supermemory | 100.0% | 81.3% | 70.0% | 100.0% | 100.0% |

The sixth family, `abstention` (6 unanswerable queries), is scored separately — see
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### Search latency

Same runs. **In-process** systems only — these are not comparable to a network call:

| system | mean | p95 |
|---|---|---|
| file | 0.07 ms | 0.16 ms |
| in-memory | 0.12 ms | 0.48 ms |
| naive-rag | 0.14 ms | 0.13 ms |
| bm25 | 0.34 ms | 0.37 ms |
| enhanced | 4.16 ms | 5.16 ms |
| dual-layer | 7.95 ms | 9.66 ms |

`supermemory` is **network-bound**: 1801.9 ms mean / 3355.2 ms p95, and 34.8 s to ingest 527
records. That is round-trip time to a hosted service, not retrieval work. Do not put it in
the table above or compare it to an in-process number.

Full breakdown, metric definitions and the abstention numbers:
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md). Harness and dataset design:
[`bench/README.md`](bench/README.md).

## Architecture

```
 Agent surfaces
   MCP server (6 tools)  ·  REST (Express 5 + zod)  ·  MemoryCoreClient SDK
   Anthropic / OpenAI tool-schema exports  ·  OpenClaw + Hermes adapters
                                │
                        MemoryCoreService
        ingest:  normalize → findDuplicate (exact text) → insert
        search:  delegate to provider
        context: search → greedy select under budget → prepend profile summary
                                │
                    MemoryProvider  (ONE interface:
                    persistence AND ranking together)
   ┌───────────┬──────────┬─────────────┬──────────────┬────────────────────┐
 in-memory    file      enhanced     dual-layer      postgres
 BM25 index   same +    mock 384d    short-term      tsvector FTS +
 + recency /  JSON on   vectors +    events +        pgvector HNSW,
 confidence / disk      regex query  long-term       server-side RRF
 importance             classes      insights,       fusion in SQL
 priors                              30s background

 src/retrieval/ — standalone primitives: BM25, embedders (ONNX / Voyage /
 OpenAI / hash), RRF + linear fusion, MMR, reranker, HybridRetriever.
 Adopted so far by: in-memory/file (BM25) and postgres (embedder interface).
 HybridRetriever is exported but is NOT yet on the service request path.
```

There is no "optimized service layer". `src/optimized-service.ts` — 657 lines of caching and
EMA metrics that an earlier version of this diagram showed as a live request-path layer — was
imported by nothing and has been deleted.

The full critique of the shape above, and the target architecture, are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Providers

Set with `MEMORY_PROVIDER`. Default `in-memory`. Retrieval numbers are from the run above;
see [`docs/providers.md`](docs/providers.md) for the scoring formulas.

| kind | storage | ranking | measured `R@10` | notes |
|---|---|---|---|---|
| `in-memory` | RAM, volatile | BM25 (max-normalized) + recency, confidence, importance, feedback | 89.8% | Default. Best measured quality of the four in-process providers. |
| `file` | one JSON file | same as in-memory | 89.8% | Rewrites the whole file per write. Single node only. |
| `enhanced` | RAM + mock vectors | regex query classification selecting one of four weight sets | 38.6% | **Not recommended.** Worst measured quality, slowest of the RAM providers. |
| `dual-layer` | RAM, events + insights | jaccard × confidence × importance, plus background consolidation every 30 s | 78.4% | Best `multi-session` of the in-process providers (81.3%). |
| `postgres` | Postgres + pgvector | tsvector FTS ∥ pgvector HNSW, fused by RRF in SQL, blended with priors | not yet benchmarked | The only durable, multi-replica-safe option. |

`postgres` is not in the harness yet — the bench systems registry does not include it. Do not
infer a number for it from the table above.

### Postgres + pgvector

Schema: [`migrations/001_init.sql`](migrations/001_init.sql). Idempotent, safe to re-run,
targets PostgreSQL 14+ and pgvector 0.5+. pgvector is optional at migrate time: the
full-text path works without it.

```bash
createdb memory_core_dev
psql -d memory_core_dev -f migrations/001_init.sql

MEMORY_PROVIDER=postgres \
MEMORY_PG_URL=postgres://localhost:5432/memory_core_dev \
npm run dev
```

- `memories` carries a generated `search_vector tsvector` (summary weighted `A`, body `B`)
  behind a partial GIN index, plus a generated `text_hash` for index-backed dedupe. Nine
  partial indexes, all leading with `(tenant_id, app_id)` and most restricted to
  `status = 'active'`.
- Embeddings live in **one narrow table per dimension** (`memory_embeddings_384`, …),
  provisioned on demand by `memory_core_ensure_embedding_dim(dims)`. pgvector's HNSW has a
  hard **2000-dimension cap**, so models above it (OpenAI `text-embedding-3-large` at 3072d)
  are indexed via a `halfvec` cast instead; `memory_core_embedding_ops_note(dims)` tells the
  query side which form to use.
- `search()` runs hybrid retrieval **in one round trip**: two independently ranked CTEs
  (lexical `ts_rank_cd`, vector cosine) fused by Reciprocal Rank Fusion in SQL, then blended
  `relevance*0.55 + recency*0.15 + confidence*0.15 + importance*0.10 + feedback`.
- `assertScope()` refuses any query missing `tenantId` or `appId`.

**Vector search is off unless an embedder is injected.** The env-driven path
(`createMemoryCoreFromConfig`) passes no embedder, so the provider runs FTS-only and
`MEMORY_EMBEDDING_MODEL` acts purely as a label stored next to vectors — it does not select a
model. To enable the vector side, construct the provider directly:

```typescript
import { PostgresMemoryProvider, LocalOnnxEmbedder, CachedEmbedder } from "./src/index.js";

const provider = new PostgresMemoryProvider({
  connectionString: process.env.MEMORY_PG_URL,
  embedder: new CachedEmbedder(new LocalOnnxEmbedder()), // 384d, matches the bootstrapped table
  embeddingModel: "Xenova/bge-small-en-v1.5",
  autoMigrate: true,
});
```

Tests: `npm run test:pg` (needs a reachable database).

## Embeddings

Real embedders live in [`src/retrieval/embedder.ts`](src/retrieval/embedder.ts), all
implementing `EmbeddingProvider { id, dims, embed(texts) }` and all L2-normalized:

| class | model / basis | dims | notes |
|---|---|---|---|
| `LocalOnnxEmbedder` | `Xenova/bge-small-en-v1.5` (default) | 384 | Default real encoder. Local ONNX via `@huggingface/transformers`; offline after a ~35 MB first download. Pipeline is lazy-loaded and cached. |
| `VoyageEmbedder` | `voyage-3` | 1024 | Needs `VOYAGE_API_KEY`. |
| `OpenAIEmbedder` | `text-embedding-3-large` | 3072 | Needs `OPENAI_API_KEY`. Above pgvector's HNSW cap — routed via `halfvec`. |
| `HashEmbedder` | signed feature-hashed bag-of-words | 512 | **Labelled lexical, not semantic**, on purpose: cosine here measures stemmed token overlap. Deterministic and offline, so it is the honest default for tests and CI. |
| `CachedEmbedder` | wrapper | inherits | In-process cache over any of the above. |

The `enhanced` provider does **not** use any of these. It still carries its own
`MockEmbeddingService`, which builds a 384-length vector by adding `sin(hash(token) + j)` to
every dimension for every token. Cosine over those vectors is a function of token hashes, not
of meaning — an earlier README advertised it as "384-dimensional embedding vectors" and
"semantic similarity", and that description was wrong. Its measured `R@10` of 38.6% is the
consequence.

## Configuration

These are all the environment variables the service reads (`src/config.ts` — anything else
you may have seen documented does not exist):

| var | default | meaning |
|---|---|---|
| `PORT` | `7401` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `MEMORY_PROVIDER` | `in-memory` | `in-memory` \| `file` \| `enhanced` \| `dual-layer` \| `postgres` |
| `MEMORY_FILE_PATH` | `./data/memory-core.json` | file provider path |
| `MEMORY_CORE_API_KEYS` | unset | comma-separated. When set, `/v1/*` requires `x-api-key` or `Authorization: Bearer` |
| `MEMORY_RATE_LIMIT_PER_MIN` | `120` | per-identity, **per process**. Must be 10–10000 |
| `MEMORY_PG_URL` / `DATABASE_URL` | dev localhost URL | Postgres connection string |
| `MEMORY_PG_AUTO_MIGRATE` | `false` | `"true"` applies `migrations/001_init.sql` on first use |
| `MEMORY_EMBEDDING_MODEL` | unset | **label only**, stored beside vectors; does not select a model |

There are no `ENHANCED_*` or `DUAL_LAYER_*` environment variables. Earlier docs listed a
dozen; none of them were ever read by any code. Those providers are configured only through
their constructors.

The MCP server has its own separate variables (`MEMORY_TENANT_ID`, `MEMORY_APP_ID`,
`MEMORY_ACTOR_ID`, …) — see [`src/integrations/README.md`](src/integrations/README.md).

## HTTP API

Every route below is verified against a running server. There is no `/metrics`, no
`/admin/*`, no `/v1/memory/export` and no `/v1/memory/import` — earlier docs listed all of
those; they return 404.

| method | route | returns |
|---|---|---|
| `GET` | `/health` | `{ok, service, timestamp}` — liveness, unauthenticated |
| `GET` | `/ready` | `{ok, service, provider:{ok, provider, detail}, timestamp}`; 503 if the provider is unhealthy |
| `POST` | `/v1/memory/ingest` | `{created, updated, records[]}` |
| `POST` | `/v1/memory/search` | `{count, hits:[{memory, score, reasons[]}]}` |
| `GET` | `/v1/memory/search?q=&tenantId=&appId=&actorId=&threadId=&types=&limit=&minScore=` | same as POST |
| `POST` | `/v1/memory/context` | `{profileSummary, selectedMemories[], contextText, totalMemories, processingTime}` |
| `GET` | `/v1/memory/profile/:tenantId/:appId/:actorId` | `{tenantId, appId, actorId, byType, summary, count}` |
| `POST` | `/v1/memory/feedback` | `{updated}` — signal is `selected` \| `positive` \| `negative` |
| `POST` | `/v1/memory/compact` | `{archivedExpired, archivedSuperseded}` |

Request validation (zod, `src/http.ts`) — the parts that bite:

- `observations[].source` is **required**, as an object with a non-empty `sourceType`.
- `observations[].text` must be **≥ 4 characters**; it is normalized and truncated to 1000.
- `filters.tenantId` and `filters.appId` are **required** on search and context. `actorId`,
  `threadId`, `memoryTypes`, `scope` and `metadata` are optional.
- `search.limit` ≤ 100, `minScore` in 0–1. `budget.maxItems` ≤ 30, `budget.maxChars` ≤ 20000.
- Defaults applied on ingest: `scope: "actor"`, `confidence: 0.7`, `importance: 0.5`,
  `decayPolicy: {kind: "time", ttlDays: 180}`.
- Validation failures return 400 with a `{message, errors:[{path, message}]}` body.

`archivedSuperseded` is returned by every provider but nothing on the write path ever sets
status `superseded` — only the `supersede` MCP tool does. Expect `0`.

## Agent integrations

Six MCP tools (`remember`, `recall`, `build_context`, `forget`, `supersede`, `feedback`) from
one zod source of truth, with adapters generated from it. Embedded mode owns its own
provider; remote mode proxies a running service. Both verified.

Full setup — MCP client config, Anthropic and OpenAI tool use, the OpenAI Agents SDK,
OpenClaw, Hermes, and an explicit verified/not-verified list — is in
[`src/integrations/README.md`](src/integrations/README.md). Two details worth repeating
because they are easy to get wrong:

- **OpenClaw's MCP config key is `mcp.servers`**, not the `mcpServers` that Claude Desktop
  uses.
- **OpenClaw ships its own bundled plugin also named `memory-core`.** Register under a
  distinct id — the helpers default to `maitrix-memory-core` — or the two collide.

Tenant, app and actor are never model-supplied; they come from server config, so a model
cannot write into the wrong tenant.

```bash
npx tsx src/integrations/mcp-server.ts   # or: npm run mcp
npm run verify:mcp                       # drives the full tool loop over stdio
```

## Development

```bash
npm run dev              # tsx src/server.ts
npm run build            # tsc -> dist/
npm start                # node dist/server.js
npm run typecheck        # tsc --noEmit (passes)
npm test                 # node:test — 98 tests, 97 pass, 1 skipped, 0 fail
npm run test:pg          # Postgres provider tests; needs a database
npm run verify:mcp       # MCP server end-to-end over stdio
npm run mcp              # run the MCP server

npm run bench            # tsx bench/run.ts
npm run bench:small      # --size=small  -> bench/out/baseline-small.json
npm run bench:large      # --size=large  -> bench/out/baseline-large.json
npm run bench:dataset    # regenerate fixtures
npm run bench:typecheck  # currently FAILS — see Known issues
```

The skipped test is the ONNX embedder integration case, gated behind
`RETRIEVAL_ONNX_TEST` so CI does not download a model.

There are no `test:integration`, `test:longmem`, `test:performance`, `test:enhanced`,
`test:dual-layer`, `bench:frameworks` or `start:prod` scripts, and no
`comprehensive_memory_test.py`. Earlier docs referenced all of them.

## Docker

```bash
docker build -t memory-core .
docker run -p 7401:7401 memory-core

# with file persistence
docker run -p 7401:7401 \
  -e MEMORY_PROVIDER=file \
  -e MEMORY_FILE_PATH=/app/data/memory-core.json \
  -v "$(pwd)/data:/app/data" \
  memory-core
```

Three stages: compile with devDependencies, resolve runtime dependencies with
`npm ci --omit=dev`, then a lean `node:22-bookworm-slim` runtime holding only `dist/`,
production `node_modules`, `package.json` and `migrations/` (the Postgres provider resolves
the migration file relative to its compiled location). Runs as the unprivileged `node` user;
`/app/data` is pre-created and owned by it. Base is Debian, not Alpine, because
`@huggingface/transformers` pulls in `onnxruntime-node` and `sharp`, whose prebuilt binaries
are glibc-linked.

The previous Dockerfile could not build: it ran `npm ci --only=production` and then
`npm run build`, with `typescript` and the `@types/*` packages in devDependencies.

For deployment beyond a single container, read
[`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) first — the rate limiter is
per-process, so it is decorative behind more than one replica.

## Known issues

- **`node_modules` is tracked in git** — 1,540 files, despite `node_modules/` being in
  `.gitignore` (it was committed before the ignore rule). Needs
  `git rm -r --cached node_modules`.
- **`npm run bench:typecheck` fails** with 157 errors, all in `src/**`.
  `bench/tsconfig.json` sets `noUncheckedIndexedAccess: true` and includes `../src/**/*.ts`,
  which the root `tsconfig.json` does not. `npm run typecheck` passes.
- **`examples/*.js` do not run** — they import `axios`, which is not a dependency.
- **No CI, no LICENSE file.** `package.json` is `private: true` with no `license` field, so
  this is not currently licensed for redistribution.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — what is wrong with the current design and
  the target shape. Start here.
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — the harness, metric definitions, full results.
- [`bench/README.md`](bench/README.md) — dataset design, task families, label integrity.
- [`docs/providers.md`](docs/providers.md) — provider internals and scoring formulas.
- [`docs/WORKING_OVERVIEW.md`](docs/WORKING_OVERVIEW.md) — request, write and read flows.
- [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) — integrating from an app.
- [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) — what is missing.
- [`docs/deployment.md`](docs/deployment.md) — running it.
- [`src/integrations/README.md`](src/integrations/README.md) — MCP and agent frameworks.
