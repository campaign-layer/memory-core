# Memory providers

Every backend implements one `MemoryProvider` interface that covers **both persistence and
ranking**. That conflation is the central design problem in this repo — see
[`ARCHITECTURE.md`](./ARCHITECTURE.md) Problem 1 — and it is why five backends have five
independent scoring functions, none of which improve when another does.

Retrieval numbers on this page come from one harness run. Read
[`BENCHMARKS.md`](./BENCHMARKS.md) for what the dataset is and is not before quoting any of
them: `memory-core-internal-retrieval` v1.0.0, synthetic, authored in this repo, **not
LongMemEval, not LoCoMo**.

```bash
npx tsx bench/run.ts --systems=random,bm25,in-memory,file,enhanced,dual-layer,naive-rag --size=small --k=10
```

## The interface

`src/provider.ts`:

```typescript
export interface MemoryProvider {
  ingest(records: MemoryRecord[]): Promise<MemoryRecord[]>;
  findDuplicate(candidate: MemoryRecord): Promise<MemoryRecord | null>;
  update(record: MemoryRecord): Promise<MemoryRecord>;
  search(query: MemorySearchQuery): Promise<MemorySearchHit[]>;
  listByActor(tenantId: string, appId: string, actorId: string): Promise<MemoryRecord[]>;
  getById(id: string): Promise<MemoryRecord | null>;
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
- `filters.tenantId` and `filters.appId` are mandatory; `in-memory`, `dual-layer` and
  `postgres` all throw rather than serve an unscoped query.
- `findDuplicate` matches on **exact normalized text** within the same actor and memory type.
  Nothing does semantic dedupe, so a revised fact is stored alongside the stale one, both
  `active`.
- `compact()` returns `{archivedExpired, archivedSuperseded}`. `archivedSuperseded` is
  effectively always `0` — nothing on the write path sets status `superseded`. Only the
  `supersede` MCP tool does.

## Selecting one

`MEMORY_PROVIDER`, default `in-memory`.

```bash
MEMORY_PROVIDER=in-memory  npm run dev   # default; RAM only
MEMORY_PROVIDER=file       npm run dev   # single-node JSON persistence
MEMORY_PROVIDER=dual-layer npm run dev
MEMORY_PROVIDER=postgres MEMORY_PG_URL=postgres://... npm run dev
```

There are **no** `ENHANCED_*` or `DUAL_LAYER_*` environment variables. Earlier revisions of
this file documented a dozen (`ENHANCED_SIMILARITY_THRESHOLD`, `DUAL_LAYER_MAX_EVENTS`,
`DUAL_LAYER_STRATEGIES`, …); none of them were ever read by any code. These providers are
configured through their constructors only.

## Summary

| kind | storage | durable | measured `R@10` | search mean / p95 | verdict |
|---|---|---|---|---|---|
| `in-memory` | RAM | no | 89.8% | 0.12 / 0.48 ms | Best-measured in-process provider. Default. |
| `file` | one JSON file | single node | 89.8% | 0.07 / 0.16 ms | Same ranking as in-memory, O(N) write amplification. |
| `enhanced` | RAM + mock vectors | no | 38.6% | 4.16 / 5.16 ms | **Do not use.** Worst real system in the harness. |
| `dual-layer` | RAM, two tiers | no | 78.4% | 7.95 / 9.66 ms | Best `multi-session` in-process (81.3%). Slowest. |
| `postgres` | Postgres + pgvector | yes | **not benchmarked** | not benchmarked | Only multi-replica-safe option. |

For reference from the same run: a plain BM25 baseline scores `R@10` 92.0% — higher than every
provider here.

---

## `in-memory`

`src/providers/in-memory-provider.ts`. RAM, volatile, zero config. **The default.**

Ranking:

```
relevance = BM25(query, text + summary), max-normalized against the top candidate
quality   = recency*0.35 + confidence*0.35 + importance*0.30 + feedbackBoost
score     = relevance * (0.7 + 0.3 * quality)
```

- Uses `BM25Index` from `src/retrieval/bm25.ts` — the one place a shared retrieval primitive
  is actually adopted by a provider.
- **Relevance gates, quality modulates.** Zero term overlap can never produce a hit, which is
  why `foundRate` is 100% and `meanRank` is 3.6.
- `feedbackBoost` = `clamp((positive − negative) * 0.05, ±0.3)`.
- Candidates are pulled from BM25 *before* re-weighting, `max(limit*5, 50)` of them, with
  tenant/app/actor/type/scope filters applied inside the BM25 scan so scoping precedes
  ranking.
- Exact-duplicate lookups go through a `dupIndex` map, so dedupe is O(1) per observation
  rather than a full scan.
- Default `minScore` is `0.05`.

Known weakness: max-normalizing BM25 means the top hit always scores ~1.0 no matter how weak
the absolute match was. That satisfies the 0–1 score contract but destroys the score's meaning
as a confidence signal, and it is why `FPR@tau` is 50% (see
[`BENCHMARKS.md`](./BENCHMARKS.md#abstention-score-calibration)).

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

## `enhanced` — not recommended

`src/providers/enhanced-provider.ts`. **The worst real system in the harness**: `R@10` 38.6%,
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

## `dual-layer`

`src/providers/dual-layer-provider.ts`. Two tiers — short-term events mirroring the canonical
records, and long-term insights derived from them by background consolidation.

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

`src/providers/postgres-provider.ts` + [`migrations/001_init.sql`](../migrations/001_init.sql).
The only durable, multi-replica-safe backend.

```bash
createdb memory_core_dev
psql -d memory_core_dev -f migrations/001_init.sql
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

Nine indexes, all leading with `(tenant_id, app_id)` because every read is tenant-scoped, and
most partial on `status = 'active'` because virtually all reads are. Metadata uses
`gin (metadata jsonb_path_ops)` — about half the size of `jsonb_ops` and it covers the `@>`
containment form that `MemoryFilters.metadata` compiles to.

**Embeddings: one narrow table per dimension.** `memory_embeddings_384`,
`memory_embeddings_1024`, … provisioned on demand by
`memory_core_ensure_embedding_dim(dims)`. pgvector requires a fixed dimension per HNSW index
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

**Vector search is disabled unless you inject an embedder.** The env-driven path
(`createMemoryCoreFromConfig` → `createMemoryProvider`) passes `embedder: null`, so
`MEMORY_PROVIDER=postgres` runs **FTS-only**, and `MEMORY_EMBEDDING_MODEL` is purely a label
stored beside vectors — it does not select a model. To enable the vector side, construct the
provider directly:

```typescript
import { PostgresMemoryProvider, LocalOnnxEmbedder, CachedEmbedder } from "../src/index.js";

const provider = new PostgresMemoryProvider({
  connectionString: process.env.MEMORY_PG_URL,
  embedder: new CachedEmbedder(new LocalOnnxEmbedder()), // 384d, matches the bootstrapped table
  embeddingModel: "Xenova/bge-small-en-v1.5",
  autoMigrate: true,
});
```

Constructor options: `pool` (a caller-owned pool is never ended by `close()`), `poolMax` (10),
`connectionTimeoutMs` (5000), `idleTimeoutMs` (30000), `statementTimeoutMs` (30000, sent as a
startup parameter to avoid an extra round trip), `embedOnIngest` (true), `rrfK` (60),
`lexicalWeight` / `vectorWeight` (1), `candidateMultiplier` (8, capped at 1000 candidates),
`hideExpiredOnRead` (true — filters decay-expired rows out of reads instead of waiting for
`compact()`), `maxListRows` (1000, a safety cap on the otherwise unbounded `listByActor`),
`autoMigrate` (false), `migrationFile`.

Operational notes:

- `assertScope()` refuses any operation missing `tenantId` or `appId`.
- Embeddings are resolved and vector literals computed **before** a transaction opens:
  provisioning a new dimension needs a lock on `memories` that an open transaction would
  block, and a network embedder has no business holding a transaction.
- `MEMORY_PG_AUTO_MIGRATE=true` applies the migration on first use.
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

**Adoption so far:** `in-memory`/`file` use `BM25Index`; `postgres` accepts the
`EmbeddingProvider` shape. `HybridRetriever` is exported from the package root but **is not on
the service request path** — nothing in `src/service.ts` or any provider calls it.

## Adding a provider

1. Implement `MemoryProvider` from `src/provider.ts` — all nine required methods.
2. Add the kind to `MemoryProviderKind` in `src/providers/factory.ts` and branch in
   `createMemoryProvider`.
3. Add it to `PROVIDER_KINDS` in `src/config.ts`. The `satisfies` + `AssertNever` pair there
   makes the build fail if you forget.
4. Enforce `tenantId` + `appId` on every read. Throw on an unscoped query; do not return
   everything.
5. Register it in `bench/systems/index.ts` and run the harness against it, including the
   `random` control, before and after. No retrieval claim ships without that.

## Migrating between providers

There is no export/import route. Earlier revisions of this file documented
`POST /v1/memory/export` and `POST /v1/memory/import`; both return 404. Move data with
`listByActor` per actor and re-`ingest` against the new provider, or at the storage layer
(copy the JSON file, `pg_dump`).

## Troubleshooting

| symptom | cause |
|---|---|
| `Invalid enum value` on startup | `MEMORY_PROVIDER` is not one of the five kinds. `src/config.ts` validates it with zod. |
| `filePath is required when MEMORY_PROVIDER=file` | `MEMORY_FILE_PATH` unset and no default resolved. |
| `MemoryFilters.tenantId and MemoryFilters.appId are required` | An unscoped search. Intentional. |
| `postgres-provider: pgvector is not installed` | `CREATE EXTENSION vector;` in the target database. |
| `embedder returned N dims but declares M` | The embedder's `dims` does not match its output. |
| Search returns nothing | `minScore` defaults differ per provider (0.05 in-memory/enhanced, 0.1 dual-layer, 0.2 postgres). Pass `minScore: 0` to see the raw ranking. |
| `archivedSuperseded` always 0 | Correct. Nothing on the write path sets that status. |

There is no `DEBUG=memory-core:*` support and no configurable log level. The HTTP layer logs
one line per request to `console.log`.
