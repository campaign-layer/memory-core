# Memory providers

Every backend implements one `MemoryProvider` interface that covers **both persistence and
ranking**. That conflation is the central design problem in this repo — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) Problem 1 — and it is why five backends have five
independent scoring functions, none of which improve when another does.

Retrieval numbers on this page come from the synthetic harness in `bench/`. Read
[`BENCHMARKS.md`](./BENCHMARKS.md) for what that dataset is and is not before quoting any of
them: `memory-core-internal-retrieval` v1.0.0, synthetic, authored in this repo, **not
LongMemEval, not LoCoMo**.

```bash
# BM25-only
npx tsx bench/run.ts --systems=random,bm25,in-memory,file,enhanced,dual-layer,naive-rag --size=small --k=10

# hybrid
MEMORY_EMBEDDER=local MEMORY_RRF_K=5 \
  npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10
```

## The interface

`src/provider.ts`:

```typescript
export interface MemoryProvider {
  ingest(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null>;
  update(record: MemoryRecord): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  listVisible(filters: MemoryFilters, limit?: number): Promise<MemoryRecord[]>;
  listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]>;
  getById(id: string, scope?: MemoryIdScope): Promise<MemoryRecord | null>;
  retire(id, status, metadataPatch, scope: MemoryIdScope): Promise<MemoryRecord | null>;
  applyFeedback(feedback: MemoryFeedbackInput): Promise<MemoryRecord | null>;
  compact(): Promise<MemoryCompactResult>;
  health?(): Promise<ProviderHealthStatus>;
  close?(): void | Promise<void>;

  // Declared optional; implemented by NO provider. Dead surface.
  ingestObservations?(tenantId: string, observations: MemoryObservation[]): Promise<void>;
  buildContext?(params: ContextBuildParams): Promise<ContextBuildResult>;
}
```

Contracts every implementation shares:

- `search` caps `limit` at 100 and defaults it to 8 or 20 depending on the provider. Scores
  are contractually 0–1.
- `filters.tenantId` and `filters.appId` are mandatory; providers throw rather than serve an
  unscoped query. `spaceId` is the stable sharing boundary and resolves to actor, then legacy
  app, when omitted.
- Visibility is centralized in `src/access.ts`: tenant crosses spaces; workspace crosses
  actors/apps in one space; app, actor, and thread progressively narrow access. Id-addressed
  operations accept the same caller scope so an opaque id cannot bypass private visibility.
- `findDuplicate` matches on **exact normalized text** within the same visibility locus and
  memory type. Nothing does semantic dedupe, so a revised fact is stored alongside the stale
  one, both `active`.
- `retire()` is a one-way, scope-checked active → `superseded`/`archived` mutation. Postgres
  performs the visibility check and update in one statement; the REST status route cannot
  restore a retired record.
- `compact()` returns `{archivedExpired, archivedSuperseded}`. Explicit supersede flows set
  the intermediate status; automatic contradiction resolution is not implemented.

## Selecting one

`MEMORY_PROVIDER` picks the backend (default `in-memory`); `MEMORY_EMBEDDER` decides whether
retrieval is hybrid or BM25-only (default `none`, meaning BM25-only).

```bash
MEMORY_PROVIDER=in-memory  npm run dev                        # default; RAM only, BM25-only
MEMORY_EMBEDDER=local      npm run dev                        # same, but hybrid BM25 + vector
MEMORY_PROVIDER=file MEMORY_FILE_PATH=./data/mc.json npm run dev
MEMORY_PROVIDER=postgres MEMORY_PG_URL=postgres://... MEMORY_EMBEDDER=local npm run dev
```

Confirm the provider kind and boolean status with `/ready`. The unauthenticated route omits
model ids, row counts and failure details; in-process hosts can inspect those through
`MemoryCoreService.getHealth()`.

There are **no** `ENHANCED_*` or `DUAL_LAYER_*` environment variables. Earlier revisions of
this file documented a dozen (`ENHANCED_SIMILARITY_THRESHOLD`, `DUAL_LAYER_MAX_EVENTS`,
`DUAL_LAYER_STRATEGIES`, …); none of them were ever read by any code. These providers are
configured through their constructors only.

## Summary

`R@10` and latency are from the synthetic harness; see [`BENCHMARKS.md`](./BENCHMARKS.md).

| kind | storage | durable | `R@10` hybrid | `R@10` BM25-only | search mean / p95 | verdict |
|---|---|---|---|---|---|---|
| `in-memory` | RAM | no | **95.5%** | 89.8% | 6.17 / 8.65 ms hybrid, 0.11 / 0.20 ms BM25-only | Default. Best measured quality. |
| `file` | one JSON file | single node | same | same | 0.07 / 0.16 ms | Identical ranking to in-memory. Single node only. |
| `enhanced` | RAM + mock vectors | no | — | 38.6% | 4.16 / 5.16 ms | **Deprecated. Do not use.** |
| `dual-layer` | RAM, two tiers | no | — | 78.4% | 7.95 / 9.66 ms | **Deprecated. Do not use.** |
| `postgres` | Postgres + pgvector | yes | **not benchmarked** | not benchmarked | not benchmarked | Only multi-replica-safe option. |

`enhanced` and `dual-layer` ignore the embedder entirely — the factory does not pass one to
either — so they have no hybrid column.

For reference from the same runs: a plain Okapi BM25 baseline scores `R@10` 92.0%, which is
**higher than the BM25-only providers** and lower than hybrid.

---

## `in-memory`

`src/providers/in-memory-provider.ts`. RAM, volatile, zero config. **The default.**

Two ranking paths, chosen per query. If no embedder is configured, no vectors have been
computed yet, or nothing clears the similarity floor, it takes the lexical path; otherwise
the hybrid path.

**Lexical path** (`MEMORY_EMBEDDER=none`, the default):

```
relevance = BM25(query, text + summary), max-normalized against the top candidate
quality   = recency*0.35 + confidence*0.35 + importance*0.30 + feedbackBoost
score     = relevance * (0.7 + 0.3 * quality)
```

**Hybrid path** (`MEMORY_EMBEDDER=local|hash|voyage|openai`):

```
fused     = RRF([bm25Candidates, vectorCandidates], rrfK)     # rrfK default 5
relevance = fused, max-normalized against the top fused candidate
score     = relevance * (0.7 + 0.3 * quality)                 # same quality term
```

- Uses `BM25Index` from `src/retrieval/bm25.ts` and `rrf` from `src/retrieval/fusion.ts`.
- **Relevance gates, quality modulates.** Zero relevance can never produce a hit, which is
  why `foundRate` is 100%.
- Candidates come from each ranker independently, `max(limit*5, 50)` of them, with
  tenant/space/scope/app/actor/thread/type filters applied *inside* each scan so authorization
  precedes ranking.
- Hybrid hits carry a `components` object — `{fused, relevance, quality, bm25, bm25Rank,
  vector, vectorRank}` — and their `reasons` name the provenance (`"lexical and vector
  match"`, `"bm25 #3"`, `"vector #1"`). This is the only place in the codebase that exposes
  per-stage component scores on the request path.
- `feedbackBoost` = `clamp((positive − negative) * 0.05, ±0.3)`.
- Exact-duplicate lookups go through a `dupIndex` map, so dedupe is O(1) per observation.
- **Embedder failures degrade rather than fail.** A throw during ingest or search logs once,
  disables the embedder for a cooldown (`embedderCooldownMs`), and retrieval continues
  BM25-only.
- Default `minScore` is `0.05`.
- `rrfK` is a constructor option (`new InMemoryProvider({ embedder, rrfK })`) and the bench
  harness reads `MEMORY_RRF_K` so a sweep needs no rebuild. It is **not** read from the
  environment by the server.

Known weakness: both paths max-normalize relevance, so the top hit always scores ~1.0 no
matter how weak the absolute match was. That satisfies the 0–1 score contract but destroys
the score's meaning as a confidence signal. Hybrid makes it worse — RRF is rank-only, so a
cosine of 1.000 and a mediocre lexical match at the same rank contribute identically. Measured
`FPR@tau` is 50% BM25-only and 66.7% hybrid; see
[`BENCHMARKS.md`](./BENCHMARKS.md#abstention-score-calibration).

## `file`

`src/providers/file-provider.ts`. Extends the in-memory provider with a JSON file, so
**retrieval quality is identical by construction** — both rows in every results table match
exactly.

```bash
MEMORY_PROVIDER=file MEMORY_FILE_PATH=./data/memory-core.json npm run dev
```

Cost: `persist()` re-serializes **every** record on every `ingest`, `update` and
`applyFeedback`, so loading a dataset is O(N²) in disk writes. Single node only — two
processes on one file will clobber each other.

## `enhanced` — DEPRECATED, do not use

`src/providers/enhanced-provider.ts`. Retained only so the evidence against it survives.
On LongMemEval it scores `R@10` **.1254** against a **.0139** random floor, with a mean rank
of 274.3 against the random control's 351.9 — the harness flagged it **at or below random on
mean rank**. On the synthetic suite it is **the worst real system**: `R@10` 38.6%,
`foundRate` 59.1% (the correct memory is outside the top 100 of a 527-memory corpus for 41% of
queries), `meanRank` 222.4 against BM25's 3.3, and ~34x `in-memory`'s search latency. It never
retrieves the right memory for knowledge-update questions (0.0%).

Previous docs described it as "Production Ready", claimed "95%+ accuracy", and advertised
"384-dimensional embedding vectors" with "semantic similarity". All of that was false. What is
actually there:

- **A `MockEmbeddingService`, not an embedder.** It builds a 384-length vector by adding
  `sin(simpleHash(token) + j)` into every dimension for every token, then L2-normalizes.
  Cosine over those vectors is a function of token hashes, not of meaning. Real embedders live
  in `src/retrieval/embedder.ts` and this provider does not use them.
- **Regex query classification** (`classifyQuery`) matching
  `first|second|third|last|before|after|when|how long|which…or`, selecting one of three weight
  sets:

  ```
  temporal:    semantic*0.30 + temporal*0.25 + entity*0.20 + lexical*0.15 + recency*0.05 + conf*0.03 + imp*0.02 + feedback
  comparative: entity*0.40   + semantic*0.30 + lexical*0.20 + recency*0.05 + conf*0.03 + imp*0.02 + feedback
  factual:     semantic*0.40 + lexical*0.25  + entity*0.20  + recency*0.08 + conf*0.04 + imp*0.03 + feedback
  ```

  The `preference` class is produced by `classifyQuery` but has no weight set — it falls
  through to `factual`.
- Default `minScore` `0.05`, default `limit` 20.

**Removed, and banned from returning:** this provider previously hardcoded another benchmark's
gold answers. `extractIntelligentAnswer()` returned the literal string
`"GPS system not functioning correctly"`, and entity gazetteers hardcoded answer keys
(`Rachel|John|Mary`, `Yellowstone|Hawaii`, `Effective Communication|Data Analysis`,
`tomatoes|marigolds|seeds`). All of it is deleted. `bench/dataset/spec.ts` now asserts that the
generated corpus contains none of those tokens, so the class of cheat cannot silently return.
Domain-specific vocabulary in ranking code is a non-negotiable in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#non-negotiables).

## `dual-layer` — DEPRECATED, do not use

`src/providers/dual-layer-provider.ts`. Two tiers — short-term events mirroring the canonical
records, and long-term insights derived from them by background consolidation. It clears the
random control comfortably but loses to BM25-only by a wide margin on the public dataset
(LongMemEval `R@10` .4764 against .8023) and is the slowest in-process provider. It ignores
`MEMORY_EMBEDDER` entirely, so it cannot benefit from hybrid retrieval.

Ranking:

```
similarity = token-set similarity(query, record.text)      # gates: 0 similarity => 0 score
quality    = confidence*0.5 + importance*0.3 + recency*0.2
score      = similarity * (0.6 + 0.4 * quality) + feedbackBoost   # feedback clamped ±0.12
```

Search covers the canonical records plus derived insight records. Short-term events are
deliberately excluded — they are verbatim mirrors, so including them would return duplicates
and could let a thread-scoped mirror escape a filter that excluded its record.

Background consolidation runs on a 30-second `setInterval`, `unref()`d so it cannot keep the
event loop alive. It merges insights whose text similarity exceeds 0.7 within the same type,
taking the max confidence and importance and unioning their `extractedFrom` provenance. That
merge loop is O(n²) per actor and unbounded.

Measured: best in-process `multi-session` score (81.3%, matching supermemory) and the best
`R@5` of the in-process providers (70.5%), at the cost of the worst in-process latency
(7.95 ms mean) and a weaker `R@10` (78.4%) than in-memory. `knowledge-update` `R@10` of 62.5%
with `staleRate` 100%.

Default `minScore` `0.1`, default `limit` 20. Caches search/context/profile results with a
timer-driven eviction that only removes expired keys, so the cache is unbounded in principle.

"Inspired by AWS Bedrock AgentCore" describes the two-tier shape only. There is no LLM in the
extraction path — insight extraction is heuristic string work, not a model call.

## `postgres`

`src/providers/postgres-provider.ts` + the ordered SQL files in [`migrations/`](../migrations/).
The only durable, multi-replica-safe backend.

```bash
createdb memory_core_dev
psql -d memory_core_dev -f migrations/001_init.sql
psql -d memory_core_dev -f migrations/002_memory_spaces.sql
MEMORY_PROVIDER=postgres MEMORY_PG_URL=postgres://localhost:5432/memory_core_dev npm run dev
npm run test:pg   # provider tests, needs a reachable database
```

PostgreSQL 14+, pgvector 0.5+. The migration is idempotent and re-runnable, and pgvector is
optional at migrate time: it wraps `CREATE EXTENSION vector` in an exception handler and the
full-text path installs and works without it.

**Schema.** `memories` carries two generated stored columns:

- `search_vector tsvector` — `setweight(summary,'A') || setweight(text,'B')`, so a curated
  one-liner outranks an incidental mention deep in the body. Behind a partial GIN index.
- `text_hash` — `md5(lower(whitespace-collapsed text))`, giving index-backed exact dedupe
  instead of an O(N) `lower(text)` scan.

Indexes cover both `(tenant_id, app_id)` provenance lookups and `(tenant_id, space_id)` access
paths; most are partial on `status = 'active'` because virtually all reads are. Metadata uses
`gin (metadata jsonb_path_ops)` — about half the size of `jsonb_ops` and it covers the `@>`
containment form that `MemoryFilters.metadata` compiles to.

**Embeddings: one narrow table per dimension.** `memory_embeddings_384`,
`memory_embeddings_1024`, … provisioned during deployment by
`memory_core_ensure_embedding_dim(dims)`. Search/ingest only inspect existing schema and never
execute DDL. pgvector requires a fixed dimension per HNSW index
but the embedding model is pluggable, so one table per dimension keeps a true fixed-dim
`vector(N)` column with a real HNSW index, lets several models coexist (distinguished by the
`model` column), keeps `memories` free of wide nullable columns, and makes a re-embedding run
a table swap.

**pgvector's HNSW has a hard 2000-dimension cap.** At or below it, the index is
`hnsw (embedding vector_cosine_ops)`. Above it — OpenAI `text-embedding-3-large` is 3072d —
the index is built on a `halfvec` cast instead, and the query side must match:
`memory_core_embedding_ops_note(dims)` returns `'vector'` or `'halfvec'` so both sides agree.
If the halfvec index cannot be built, the migration raises a notice and vector search stays
exact but unindexed rather than failing.

**Search is hybrid in one round trip.** Two independently ranked CTEs — lexical
`ts_rank_cd(search_vector, tsquery, 32)` and vector cosine — each filtering `memories`
directly so the planner can pick GIN for one side and HNSW for the other. They are fused by
Reciprocal Rank Fusion **in SQL** (`weight / (rrfK + rank)`, default `rrfK` 60, both weights
1), normalized against the maximum achievable RRF score, then blended with the record's own
priors:

```
score = relevance*0.55 + recency*0.15 + confidence*0.15 + importance*0.10 + feedback
```

`recency` is a 30-day half-life exponential decay; `feedback` is
`clamp((positive − negative) * 0.02, ±0.12)`. An empty query falls back to
`recency*0.4 + confidence*0.3 + importance*0.3 + feedback` over the newest active rows. Every
caller-supplied value goes through a bind parameter — nothing is interpolated.

**Vector search follows `MEMORY_EMBEDDER`.** The env-driven path
(`createMemoryCoreFromConfig` → `createMemoryProvider`) resolves the embedder from
`MEMORY_EMBEDDER` and hands it to the provider, so:

```bash
MEMORY_PROVIDER=postgres MEMORY_PG_URL=postgres://... npm run dev                      # FTS-only
MEMORY_PROVIDER=postgres MEMORY_PG_URL=postgres://... MEMORY_EMBEDDER=local npm run dev # hybrid
```

An earlier revision of this file said the env path passed `embedder: null` and that the vector
side could only be reached by constructing the provider directly. That is no longer true.

Constructing it directly is still the way to supply a custom embedder or wrap one in a cache:

```typescript
import { PostgresMemoryProvider, LocalOnnxEmbedder, CachedEmbedder } from "../src/index.js";

const provider = new PostgresMemoryProvider({
  connectionString: process.env.MEMORY_PG_URL,
  embedder: new CachedEmbedder(new LocalOnnxEmbedder()), // 384d, matches the bootstrapped table
  embeddingModel: "Xenova/bge-small-en-v1.5",
  autoMigrate: true,
});
```

**`rrfK` differs between backends.** The Postgres provider still defaults to **60**; the
in-process providers default to **5**. The evidence for lowering it (deeper recall improves,
nothing regresses) is in [`BENCHMARKS.md`](./BENCHMARKS.md#rrfk-on-a-subset) and was gathered
on the in-process path. The Postgres default has not been re-measured, which is why it has not
been changed.

Constructor options: `pool` (a caller-owned pool is never ended by `close()`), `poolMax` (10),
`connectionTimeoutMs` (5000), `idleTimeoutMs` (30000), `statementTimeoutMs` (30000, sent as a
startup parameter to avoid an extra round trip), `embedOnIngest` (true),
`embedderCooldownMs` (60000), `rrfK` (60),
`lexicalWeight` / `vectorWeight` (1), `candidateMultiplier` (8, capped at 1000 candidates),
`hideExpiredOnRead` (true — filters decay-expired rows out of reads instead of waiting for
`compact()`), `maxListRows` (1000, a safety cap on the otherwise unbounded `listByActor`),
`autoMigrate` (false), `migrationFile` (single-file override; the default applies all bundled
versions).

Operational notes:

- Search/list operations refuse filters missing `tenantId` or `appId`; scoped id reads and
  writes require tenant plus a space or actor-derived personal space. An app id alone is not
  an opaque-id capability.
- Embedding tables are resolved read-only and vector literals are computed **before** a write
  transaction opens; a network embedder has no business holding a transaction.
- `MEMORY_PG_AUTO_MIGRATE=true` takes a Postgres advisory lock, verifies SHA-256 checksums,
  applies only ledger-pending ordered migrations, and provisions a missing configured
  embedding dimension before the production HTTP listener opens.
- Search-time vector table/embedder failures log once, enter a cooldown, and execute the
  lexical CTE without exposing hosted-provider details to HTTP callers.
- `DEFAULT_PG_URL` is a developer-machine localhost URL. Always set `MEMORY_PG_URL` or
  `DATABASE_URL` explicitly.
- **No retrieval number exists for this provider** — it is not registered in
  `bench/systems/index.ts`.

## Retrieval primitives

`src/retrieval/` holds the pieces a shared ranking layer would be built from, each with unit
tests:

| module | what |
|---|---|
| `bm25.ts` | Okapi BM25 index with add/remove/search and a filter callback |
| `embedder.ts` | `LocalOnnxEmbedder` (bge-small-en-v1.5, 384d, offline), `VoyageEmbedder`, `OpenAIEmbedder`, `HashEmbedder` (labelled lexical), `CachedEmbedder` |
| `fusion.ts` | RRF and weighted linear fusion with min-max normalization |
| `mmr.ts` | Maximal Marginal Relevance diversification |
| `rerank.ts` | `Reranker` interface |
| `index.ts` | `HybridRetriever` — BM25 ∥ vector → fuse → optional rerank → optional MMR, with per-stage component scores |

**Adoption so far:** `in-memory`/`file` use `BM25Index` and `rrf`, and expose per-stage
component scores on hybrid hits; `postgres` accepts the `EmbeddingProvider` shape and does its
own RRF in SQL. `MemoryCoreService` now uses the `Reranker` interface as an optional,
provider-independent cross-encoder stage, so REST and agent surfaces receive the same reranked
order. `mmr.ts` remains unused — no provider diversifies. `HybridRetriever` is exported from
the package root but **is not on the service request path**; the providers reimplement the
same candidate/fusion shape internally, which is
[Problem 1](./ARCHITECTURE.md#problem-1--the-provider-interface-conflates-storage-with-ranking).

## Adding a provider

Step-by-step in [`CONTRIBUTING.md`](../CONTRIBUTING.md#adding-a-provider). The rules that are
not negotiable: enforce `tenantId` + `appId` on every query, implement the complete
space/scope visibility policy (including id-addressed mutations), and register the provider in
`bench/systems/index.ts` and run the harness with the `random` control before making any
retrieval claim.

## Migrating between providers

There is no export/import route. Earlier revisions of this file documented
`POST /v1/memory/export` and `POST /v1/memory/import`; both return 404. Move data with
`listVisible` per access space and re-`ingest` against the new provider, or at the storage layer
(copy the JSON file, `pg_dump`).

## Troubleshooting

| symptom | cause |
|---|---|
| `Invalid enum value` on startup | `MEMORY_PROVIDER` is not one of the five kinds. `src/config.ts` validates it with zod. |
| `filePath is required when MEMORY_PROVIDER=file` | `MEMORY_FILE_PATH` unset and no default resolved. |
| `MemoryFilters.tenantId and MemoryFilters.appId are required` | An unscoped search. Intentional. |
| Id operation requires `tenantId plus spaceId or appId` | An unscoped opaque-id read/mutation on strict Postgres mode. Intentional. |
| `postgres-provider: pgvector is not installed` | `CREATE EXTENSION vector;` in the target database. |
| `embedder returned N dims but declares M` | The embedder's `dims` does not match its output. |
| Search returns nothing | `minScore` defaults differ per provider (0.05 in-memory/enhanced, 0.1 dual-layer, 0.2 postgres). Pass `minScore: 0` to see the raw ranking. |
| `archivedSuperseded` stays 0 | Expected unless an explicit supersede flow marked records before compaction; there is no automatic Resolver. |

There is no `DEBUG=memory-core:*` support and no configurable log level. The HTTP layer logs
one line per request to `console.log`.
