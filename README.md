# memory-core

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

An HTTP + MCP memory service for AI agents. Ingest typed observations, retrieve them by
hybrid BM25 + vector search, and build a prompt-ready context block. Storage is pluggable
behind one provider interface: in-memory, JSON file, or Postgres + pgvector.

Pre-1.0. Retrieval quality is measured rather than asserted, and the measurements include
the cases where we lose. Every number below names the command that produces it.

---

## What it is

- **Typed memory store.** `fact`, `preference`, `goal`, `project`, `episode`, `tool_outcome`,
  `instruction`, `profile`, `pattern`, `summary` — scoped by tenant / app / actor / thread.
- **Hybrid retrieval.** Okapi BM25 in parallel with vector cosine, fused by Reciprocal Rank
  Fusion (`rrfK` 5 in the in-process providers). Falls back to BM25-only when no embedder is
  configured or when the embedder fails.
- **Pluggable embedders.** Local ONNX (offline, no API key), Voyage, OpenAI, or a
  deterministic hash embedder for tests. Selected with one environment variable.
- **Durable backend.** Postgres + pgvector with tsvector FTS, HNSW vector indexes, and RRF
  fusion executed in SQL in a single round trip.
- **Agent surfaces.** REST, an MCP server with 6 tools, Anthropic and OpenAI tool-schema
  exports, an OpenAI Agents SDK adapter, and OpenClaw + Hermes adapters.
- **Budgeted context blocks.** `POST /v1/memory/context` returns one text block of a profile
  summary plus ranked memories, capped by item count and character count.

## What it is not

- **No extraction by default.** The write path stores what you send it, so raw conversation
  turns are stored as raw turns. An opt-in LLM extractor (`MEMORY_EXTRACTOR=llm`) landed
  recently and is **off by default and unmeasured** — every benchmark number on this page was
  produced with extraction off. Do not assume it closes the gap in
  [Where we lose](#where-we-lose) until there is a number for it.
- **No automatic supersession.** Duplicate detection is exact normalized-text equality.
  "I live in Lisbon" and "I moved to Berlin" both persist as `active` and both stay
  retrievable. Supersession exists only as an explicit `supersede` MCP tool call.
- **No reranking and no multi-hop** on the request path. `src/retrieval/` ships a `Reranker`
  interface and an MMR implementation; neither is wired into `search()`.
- **Not operated at scale by us.** The rate limiter is per-process, API keys are not scoped
  to a tenant, and there is no `/metrics` endpoint. See
  [docs/deployment.md](docs/deployment.md#limits-to-know-before-you-deploy).

---

## Quickstart

Every command and every response below was executed against a running server on Node 22.14
before publishing; the outputs are copied from that session, not written by hand.

```bash
git clone https://github.com/campaign-layer/memory-core
cd memory-core
npm install
npm run dev              # tsx src/server.ts, listens on 0.0.0.0:7401
```

```bash
curl -s localhost:7401/health
# {"ok":true,"service":"memory-core","timestamp":"2026-07-30T05:56:44.251Z"}

curl -s localhost:7401/ready
# {"ok":true,"service":"memory-core","provider":{"ok":true,"provider":"in-memory",
#  "detail":"records=0, indexed=0, embedder=none"},"timestamp":"..."}
```

Ingest. `tenantId`, `appId`, `actorId`, `memoryType`, `text` and `source` are all required;
`text` must be at least 4 characters.

```bash
curl -s -X POST localhost:7401/v1/memory/ingest \
  -H 'content-type: application/json' \
  -d '{"observations":[{
        "tenantId":"demo","appId":"chatbot","actorId":"user123",
        "memoryType":"preference",
        "text":"Prefers vegetarian Italian restaurants",
        "source":{"sourceType":"chat"},
        "confidence":0.9,"importance":0.8}]}'
# {"created":1,"updated":0,"records":[{"id":"mem_...", ...}]}
```

Build a context block. `filters.tenantId` and `filters.appId` are required.

```bash
curl -s -X POST localhost:7401/v1/memory/context \
  -H 'content-type: application/json' \
  -d '{"query":"restaurant recommendation",
       "filters":{"tenantId":"demo","appId":"chatbot","actorId":"user123"},
       "budget":{"maxItems":10,"maxChars":2000}}'
# {"profileSummary":"Preferences:\n- Prefers vegetarian Italian restaurants",
#  "selectedMemories":[{"id":"mem_...","memoryType":"preference","score":0.9715,
#    "reasons":["strong term match","recent memory","high confidence","high importance"]}],
#  "contextText":"KNOWN ACTOR PROFILE:\n...\n\nRELEVANT MEMORIES:\n- [preference] ...",
#  "totalMemories":1,"processingTime":0.612}
```

Turn on semantic retrieval. `MEMORY_EMBEDDER=local` downloads a ~35 MB ONNX model once and
then runs offline; `hash` is deterministic and needs no download.

```bash
MEMORY_EMBEDDER=local npm run dev
curl -s localhost:7401/ready
# ..."detail":"records=0, indexed=0, embedder=onnx:Xenova/bge-small-en-v1.5/384d vectors=0"
```

A runnable end-to-end script lives in [`examples/quickstart.mjs`](examples/quickstart.mjs)
(no dependencies beyond Node 18's built-in `fetch`).

From TypeScript:

```typescript
import { MemoryCoreClient } from "./src/client.js";

const memory = new MemoryCoreClient({ baseUrl: "http://localhost:7401" });

await memory.ingest({
  observations: [{
    tenantId: "demo", appId: "chatbot", actorId: "user123",
    memoryType: "preference",
    text: "Prefers vegetarian Italian restaurants",
    source: { sourceType: "chat" },
  }],
});

const context = await memory.buildContext({
  query: "Recommend a restaurant",
  filters: { tenantId: "demo", appId: "chatbot", actorId: "user123" },
  budget: { maxItems: 10, maxChars: 2000 },
});
console.log(context.contextText);
```

---

## Retrieval quality

### How to read this section

Three datasets, in ascending order of evidential weight. All numbers come from **our own
harness**, and that is the single most important caveat on the page:

> **These are not leaderboard scores.** LongMemEval and LoCoMo are public datasets, but the
> retrieval granularity, the reader model, and the judge model here are ours. Published
> numbers from the LongMemEval and LoCoMo papers, or from any vendor's blog post, were
> measured differently and **must not be compared to the tables below.** The only valid
> comparisons are within a table, because every row in a table went through the same harness
> over the same corpus with the same metric definitions.

> **Every harness is in this repository.** The synthetic suite lives in
> [`bench/`](bench/README.md); the LongMemEval and LoCoMo harnesses — including the mem0
> comparison and the QA reader/judge — live in [`bench/longmemeval/`](bench/longmemeval/) and
> [`bench/locomo/`](bench/locomo/), with the result artifacts behind every table committed
> alongside them. The datasets themselves are third-party and are not vendored; each harness
> has a `DATA.md` with the download source and expected checksum.

### 1. Synthetic suite (`bench/`) — our dataset, weakest evidence

`memory-core-internal-retrieval` v1.0.0: a synthetic corpus authored inside this repository.
527 memories, 17 sessions, seed 1337, fixture hash `8c0cbec5d2f8aded`, n = 44 answerable
queries (6 unanswerable scored separately), retrieval depth 100.

**We wrote this dataset, so it can flatter our own systems.** It measures whether a retriever
ranks the right memory above vocabulary-sharing distractors, and nothing else. It says nothing
about real user phrasing, long documents, or answer quality. Treat any cross-system gap here
as a hypothesis, not a result.

```bash
# hybrid row
MEMORY_EMBEDDER=local MEMORY_RRF_K=5 \
  npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# BM25-only row (MEMORY_EMBEDDER unset defaults to none)
npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# supermemory row (needs SUPERMEMORY_API_KEY)
npx tsx bench/run.ts --systems=supermemory --size=small --k=10
```

| system | R@1 | R@5 | R@10 | MRR | nDCG@10 |
|---|---|---|---|---|---|
| memory-core hybrid (local ONNX, `rrfK=5`) | **48.9%** | **83.0%** | **95.5%** | **0.688** | **0.721** |
| `bm25` baseline (Okapi, lexical only) | 34.1% | 67.0% | 92.0% | 0.587 | 0.633 |
| memory-core BM25-only | 40.9% | 62.5% | 89.8% | 0.615 | 0.648 |
| supermemory (live API) | 40.9% | 80.7% | 89.8% | 0.662 | 0.688 |
| random control | 0.0% | 1.1% | 1.1% | 0.017 | 0.009 |

The `supermemory` row comes from a separate invocation of the same harness against the same
fixture hash. The `random` control is re-run in every invocation and matched bit-for-bit
across both (R@10 1.1%, MRR 0.0171, meanRank 407.2), which is the evidence that the two runs
are on the same footing. It is still weaker than a single run, and it is called out here
rather than hidden.

Two things this table shows that are not in our favour:

- **Without an embedder, we lose to supermemory in the middle of the ranking.** BM25-only
  ties on R@1 and R@10 but trails on R@5 (62.5% vs 80.7%), MRR, and nDCG@10. For an agent
  splicing the top 5 into a prompt, that is the gap that matters, and it is theirs.
- **Without an embedder, plain Okapi BM25 beats our own BM25-only provider on R@10**
  (92.0% vs 89.8%). Our recency and confidence priors cost recall depth to buy R@1.

Turning on the embedder fixes both, at a cost: ingest goes from 6 ms to 3.7 s for 527 records
and search from 0.11 ms to 6.2 ms mean, on the same machine in the runs above.

Full breakdown, metric definitions, per-family results, abstention calibration and latency:
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).

### 2. LongMemEval_S — public dataset, our harness

500 questions, 479 scored; the 21 abstention questions are scored separately.

| system | R@1 | R@10 | R@30 | MRR | meanRank |
|---|---|---|---|---|---|
| memory-core | .3429 | **.8023** | **.8892** | **.6479** | **20.8** |
| bm25 baseline | **.3619** | .7797 | .8679 | .6459 | 28.8 |
| mc-dual-layer | .0494 | .4764 | .6649 | .2339 | 52.7 |
| mc-enhanced | .0565 | .1254 | .1936 | .1355 | 274.3 |
| random control | .0017 | .0139 | .0576 | .0180 | 351.9 |

**A lexical BM25 baseline beats us on R@1** (.3619 vs .3429). We win recall depth — R@10,
R@30, and mean rank 20.8 vs 28.8 — which is the same shape as the synthetic suite: hybrid
retrieval buys depth, not top-1 precision.

Hybrid retrieval was evaluated on a **150-question stratified subset (n = 142 scored)**, not
the full 500. On that subset, `rrfK=5` scores R@10 **.8716** against `rrfK=60`'s **.8648**.
That subset and the n = 479 table above are different runs with different denominators; do
not combine them.

Answer accuracy, with a `deepseek/deepseek-v4-flash` reader and the same model as judge,
over **BM25-only retrieval** (`memory-core`, `embedder=none`) — no hybrid Mode B run exists,
so these do not show what hybrid retrieval would score. Bracketed figures are 95% confidence
intervals:

| condition | accuracy |
|---|---|
| retrieval @ k=10 | 62.6% [58.2 – 66.8] |
| retrieval @ k=30 | 69.5% [65.3 – 73.5] |
| oracle (gold evidence supplied directly) | 82.0% [75.1 – 87.3] |

The oracle row is the ceiling the reader imposes: even handed the correct evidence, the
answering step gets 18% wrong. Retrieval improvements above roughly 82% are unmeasurable
with this reader.

### 3. LoCoMo — public dataset, our harness, head-to-head with mem0

10 conversations, n = 1,531 answerable questions, against **mem0 OSS 2.0.14** run by us
through the same harness.

| system | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 |
|---|---|---|---|---|---|---|
| mem0 | **.345** | **.635** | .694 | .783 | **.534** | **.548** |
| memory-core hybrid (`rrfK=5`) | .344 | .620 | **.709** | **.817** | .524 | .544 |
| memory-core BM25-only | .332 | .555 | .626 | .726 | .482 | .494 |
| bm25 baseline | .303 | .507 | .578 | .673 | .437 | .450 |
| random control | .002 | .012 | .020 | .057 | .012 | .010 |

Answer accuracy on matched denominators (n = 233): oracle .485, **mem0 @ k=30 .476**,
memory-core hybrid @ k=30 .451. The oracle ceiling of .485 means the reader dominates and
all retrieval systems compress underneath it — rank metrics are the signal on this dataset,
not QA accuracy.

Ingest cost for the same 5,882 conversation turns:

| system | wall clock | LLM calls | prompt tokens | cost | search latency |
|---|---|---|---|---|---|
| memory-core BM25-only | 0.07 s | 0 | 0 | $0 | 0.167 ms |
| memory-core hybrid | 104 s | 0 | 0 | $0 | 15.8 ms |
| mem0 | 28,827 s | 5,882 | 51.6 M | $3.45 | 37.9 ms |

### Where we lose

Stated plainly, because a README that only lists wins is the failure mode this repository
already had once:

1. **mem0 beats us on LoCoMo R@1, R@5, MRR and nDCG@10**, and on QA accuracy (.476 vs .451).
   Its advantage comes from LLM extraction on the write path — it distils turns into atomic
   facts before storing them. Every memory-core number above was measured with extraction
   **off**, which is the default. An opt-in `MEMORY_EXTRACTOR=llm` path now exists but has no
   measured number, so this row stands until someone produces one.
2. **A plain BM25 baseline beats us on LongMemEval R@1** (.3619 vs .3429).
3. **supermemory beats us on R@5, MRR and nDCG@10 on our own synthetic suite** whenever we
   run BM25-only.
4. **Nothing here handles knowledge updates.** A revised fact is stored beside the stale one,
   both `active`, both retrievable forever. Every system we measured fails this, including
   supermemory — but "everyone fails" is not a defence.

What we do win: **retrieval depth** (R@10 / R@30 / mean rank on both public datasets),
**single-hop questions**, and **cost** — mem0's LoCoMo ingest cost 5,882 LLM calls and $3.45
against $0 and zero calls for either memory-core configuration, at roughly 277x the wall
clock.

### Retracted claim

A previous version of this README advertised **"27.9% accuracy on LongMemEval"** for the
`enhanced` provider. **That number was fabricated by the code that produced it.** The
provider's `extractIntelligentAnswer()` returned the literal string
`"GPS system not functioning correctly"` — verbatim the gold answer to LongMemEval question 1
— and entity gazetteers hardcoded further answer keys. It measured answer injection, not
retrieval.

That code is deleted. `bench/dataset/spec.ts` now asserts that the generated corpus contains
none of those tokens, so the same class of cheat cannot return silently. The number is
retracted and is not replaced by any other figure for that provider; `enhanced`'s actual
measured LongMemEval R@10 is **.1254**, against a **.0139** random floor.

Anyone who finds the old claim in this repository's git history should read this paragraph
as the correction.

### Deprecated: `enhanced` and `dual-layer`

**Do not use either.** Both remain in the tree because deleting them would erase the evidence
above, and both are excluded from any recommendation.

| provider | LongMemEval R@10 | LongMemEval meanRank | status |
|---|---|---|---|
| `enhanced` | .1254 (random floor .0139) | 274.3 (random 351.9) | **Deprecated.** Flagged at-or-below random on mean rank by the harness. |
| `dual-layer` | .4764 | 52.7 | **Deprecated.** Beats random, loses to BM25-only by a wide margin. |

`enhanced` scores below one seventh of the `memory-core` row on R@10 and its mean rank sits
closer to the random control than to any real system. Its "384-dimensional embedding vectors"
were a `MockEmbeddingService` that built a vector by adding `sin(hash(token) + j)` into every
dimension — cosine over those vectors is a function of token hashes, not of meaning.

Use `in-memory` (default), `file` for single-node persistence, or `postgres` for anything
durable.

---

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
 BM25 ∥ vec   same +    DEPRECATED   DEPRECATED      tsvector FTS ∥
 → RRF(k=5)   JSON on   mock 384d    short-term      pgvector HNSW,
 + recency /  disk      vectors      events +        RRF fused in SQL
 confidence /                        long-term       + priors
 importance                          insights
 priors

 src/retrieval/ — BM25, embedders (ONNX / Voyage / OpenAI / hash), RRF + linear
 fusion, MMR, reranker interface, HybridRetriever.
 Adopted: in-memory/file (BM25 + vectors + RRF), postgres (embedder interface).
 HybridRetriever itself is exported but NOT on the service request path.
```

The provider interface conflating storage with ranking is the central design problem, and the
plan for fixing it is the strategic document of this repository:
**[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**. Read it before proposing a change to
retrieval.

## Providers

Set with `MEMORY_PROVIDER`, default `in-memory`. `R@10` is from the synthetic suite run above.

| kind | storage | ranking | synthetic `R@10` | notes |
|---|---|---|---|---|
| `in-memory` | RAM, volatile | BM25 ∥ vector → RRF(`k=5`) → recency / confidence / importance / feedback priors | 95.5% hybrid, 89.8% BM25-only | Default. |
| `file` | one JSON file | same as in-memory | same | Single node only; rewrites coalesce, but two writers corrupt it. |
| `enhanced` | RAM + mock vectors | regex query classification over four weight sets | 38.6% | **Deprecated.** |
| `dual-layer` | RAM, events + insights | jaccard × confidence × importance, 30 s background consolidation | 78.4% | **Deprecated.** |
| `postgres` | Postgres + pgvector | tsvector FTS ∥ HNSW, RRF in SQL, blended with priors | not in the harness | The only durable, multi-replica-safe option. |

`postgres` is not registered in `bench/systems/index.ts`, so it has **no measured retrieval
number**. Do not infer one from the rows above.

### Postgres + pgvector

Schema: [`migrations/001_init.sql`](migrations/001_init.sql). Idempotent, PostgreSQL 14+ and
pgvector 0.5+. pgvector is optional at migrate time — the full-text path works without it.

```bash
createdb memory_core_dev
psql -d memory_core_dev -f migrations/001_init.sql

MEMORY_PROVIDER=postgres \
MEMORY_PG_URL=postgres://localhost:5432/memory_core_dev \
MEMORY_EMBEDDER=local \
npm run dev
```

- `memories` carries a generated `search_vector tsvector` (summary weighted `A`, body `B`)
  behind a partial GIN index, plus a generated `text_hash` for index-backed dedupe. Nine
  partial indexes, all leading with `(tenant_id, app_id)`.
- Embeddings live in **one narrow table per dimension** (`memory_embeddings_384`, …),
  provisioned on demand by `memory_core_ensure_embedding_dim(dims)`.
- **pgvector's HNSW has a hard 2000-dimension cap.** At or below it the index is
  `hnsw (embedding vector_cosine_ops)`. Above it — OpenAI `text-embedding-3-large` is 3072d —
  the index is built on a **`halfvec` cast** instead, and
  `memory_core_embedding_ops_note(dims)` tells the query side which form to use so both
  agree. If the halfvec index cannot be built, the migration raises a notice and vector
  search stays exact but unindexed rather than failing.
- `search()` runs both sides in **one round trip**: two independently ranked CTEs (lexical
  `ts_rank_cd`, vector cosine) fused by RRF in SQL, then blended
  `relevance*0.55 + recency*0.15 + confidence*0.15 + importance*0.10 + feedback`.
- The Postgres provider still defaults to `rrfK` **60**; the in-process providers default to
  **5**. See [`docs/providers.md`](docs/providers.md#postgres).
- `assertScope()` refuses any query missing `tenantId` or `appId`.

Tests: `npm run test:pg` (needs a reachable database).

## Embeddings

`MEMORY_EMBEDDER` selects one. All implement `EmbeddingProvider { id, dims, embed(texts) }`
and all are L2-normalized ([`src/retrieval/embedder.ts`](src/retrieval/embedder.ts)).

| value | class | model / basis | dims | notes |
|---|---|---|---|---|
| `none` | — | — | — | **Default.** BM25-only ranking. |
| `local` | `LocalOnnxEmbedder` | `Xenova/bge-small-en-v1.5` | 384 | Local ONNX via `@huggingface/transformers`. Offline after a ~35 MB first download. |
| `voyage` | `VoyageEmbedder` | `voyage-3` | 1024 | Needs `VOYAGE_API_KEY`. |
| `openai` | `OpenAIEmbedder` | `text-embedding-3-large` | 3072 | Needs `OPENAI_API_KEY`. Above pgvector's HNSW cap — routed via `halfvec`. |
| `hash` | `HashEmbedder` | signed feature-hashed bag-of-words | 512 | **Labelled lexical, not semantic**, deliberately: cosine here measures stemmed token overlap. Deterministic and offline, so it is the honest default for tests. |

`CachedEmbedder` wraps any of the above with an in-process cache.

If the embedder throws during ingest or search, the in-process providers log once, disable it
for a cooldown, and continue BM25-only rather than failing the request.

## Configuration

Every environment variable the service reads (`src/config.ts`). Unknown keys are stripped by
zod, so a typo is silently ignored — check `/ready` to confirm what actually started.

| var | default | meaning |
|---|---|---|
| `PORT` | `7401` | HTTP port. 1–65535 or startup throws. |
| `HOST` | `0.0.0.0` | bind address |
| `MEMORY_PROVIDER` | `in-memory` | `in-memory` \| `file` \| `enhanced` \| `dual-layer` \| `postgres` |
| `MEMORY_FILE_PATH` | `./data/memory-core.json` | `file` provider path |
| `MEMORY_CORE_API_KEYS` | unset | comma-separated. When set, `/v1/*` requires `x-api-key` or `Authorization: Bearer` |
| `MEMORY_RATE_LIMIT_PER_MIN` | `120` | per identity, **per process**. Must be 10–10000 |
| `MEMORY_PG_URL` / `DATABASE_URL` | dev localhost URL | Postgres connection string |
| `MEMORY_PG_AUTO_MIGRATE` | `false` | exactly `"true"` applies `migrations/001_init.sql` on first use |
| `MEMORY_EMBEDDER` | `none` | `none` \| `local` \| `hash` \| `voyage` \| `openai` |
| `MEMORY_EMBEDDING_MODEL` | unset | model id override, and the label stored beside vectors |
| `MEMORY_EMBEDDING_DIMS` | unset | dimension override, 1–16000 |
| `MEMORY_EXTRACTOR` | `none` | `none` (passthrough — stores each observation verbatim) \| `llm` |
| `MEMORY_EXTRACTOR_BASE_URL` | `https://api.openai.com/v1` | any OpenAI-compatible chat endpoint |
| `MEMORY_EXTRACTOR_API_KEY` | unset | key for the above |
| `MEMORY_EXTRACTOR_MODEL` | `gpt-4o-mini` | extraction model |
| `MEMORY_EXTRACTOR_BATCH_SIZE` | unset | turns per extraction call, 1–200 |

`VOYAGE_API_KEY` and `OPENAI_API_KEY` are read by the corresponding embedder classes only.

`MEMORY_EXTRACTOR` defaults to `none` so that an existing deployment's write path is
unchanged. The `llm` kind costs one model call per batch of turns and has **no measured
retrieval or quality number yet** — it is not covered by anything in
[Retrieval quality](#retrieval-quality).

There are no `ENHANCED_*` or `DUAL_LAYER_*` variables — earlier documentation listed a dozen
and none were ever read by any code. The MCP server reads its own separate set; see
[`src/integrations/README.md`](src/integrations/README.md).

## HTTP API

Every route below was exercised against a running server before publishing. There is no
`/metrics`, no `/admin/*`, no `/v1/memory/export` and no `/v1/memory/import`; they return 404.

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

Validation rules that bite most often (zod, `src/http.ts`):

- `observations[].source` is **required**, an object with a non-empty `sourceType`.
- `observations[].text` must be **≥ 4 characters**; it is whitespace-collapsed and truncated
  to 1000.
- `filters.tenantId` and `filters.appId` are **required** on search and context.
- `search.limit` ≤ 100, `minScore` 0–1. `budget.maxItems` ≤ 30, `budget.maxChars` ≤ 20000.
- Ingest defaults: `scope: "actor"`, `confidence: 0.7`, `importance: 0.5`,
  `decayPolicy: {kind: "time", ttlDays: 180}`.
- Validation failures return 400 with `{message, errors:[{path, message}]}`.

`archivedSuperseded` is returned by every provider but nothing on the write path sets status
`superseded` — only the `supersede` MCP tool does. Expect `0`.

## Agent integrations

Six MCP tools — `remember`, `recall`, `build_context`, `forget`, `supersede`, `feedback` —
generated from one zod source of truth, with adapters derived from it. Embedded mode owns its
own provider; remote mode proxies a running service.

```bash
npm run mcp              # run the MCP server over stdio
npm run verify:mcp       # drives the full tool loop end to end
```

Tenant, app and actor are **never model-supplied** — they come from server config, so a model
cannot write into the wrong tenant.

Two details that are easy to get wrong:

- **OpenClaw's MCP config key is `mcp.servers`**, not the `mcpServers` that Claude Desktop
  uses.
- **OpenClaw ships its own bundled plugin also named `memory-core`.** Register under a
  distinct id or the two collide.

Full setup for MCP clients, Anthropic and OpenAI tool use, the OpenAI Agents SDK, OpenClaw
and Hermes — with an explicit verified / not-verified list — is in
[`src/integrations/README.md`](src/integrations/README.md).

## Development

```bash
npm run dev              # tsx src/server.ts
npm run build            # tsc -> dist/
npm start                # node dist/server.js
npm run typecheck        # tsc --noEmit — passes
npm test                 # node:test — all pass; 1 skipped (ONNX, opt-in)
npm run test:pg          # Postgres provider tests; needs a database
npm run verify:mcp       # MCP server end to end over stdio
npm run mcp              # run the MCP server

npm run bench            # tsx bench/run.ts
npm run bench:small      # --size=small -> bench/out/baseline-small.json
npm run bench:large      # --size=large -> bench/out/baseline-large.json
npm run bench:dataset    # regenerate fixtures deterministically
npm run bench:typecheck  # currently FAILS — see Known issues
```

The skipped test is the ONNX embedder integration case, gated behind `RETRIEVAL_ONNX_TEST` so
CI does not download a model.

Contributor guide, including how to add a provider or an embedder and the rules for shipping a
benchmark number: [`CONTRIBUTING.md`](CONTRIBUTING.md).

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
the migration file relative to its compiled location). Runs as the unprivileged `node` user.
The base is Debian rather than Alpine because `@huggingface/transformers` pulls in
`onnxruntime-node` and `sharp`, whose prebuilt binaries are glibc-linked.

Deployment guidance, docker-compose, Kubernetes and the operational limits:
[`docs/deployment.md`](docs/deployment.md).

## Known issues

- **`npm run bench:typecheck` fails**, with every error in `src/**`. `bench/tsconfig.json`
  sets `noUncheckedIndexedAccess: true` and includes `../src/**/*.ts`, which the root
  `tsconfig.json` does not. `npm run typecheck` passes and the bench harness itself is clean.
- **The datasets are not vendored.** The harnesses are committed, but LongMemEval_S (278 MB)
  and LoCoMo are third-party downloads — see each harness's `DATA.md`. Mode B additionally
  needs an API key, and the mem0 comparison needs a Python environment and roughly $3.50.
- **The `postgres` provider has no measured retrieval number** — it is not registered as a
  bench system, and it is the only durable backend.
- **`buildContext` is unmeasured** and it is the endpoint agents actually call. It budgets in
  characters rather than tokens (roughly 4x off, model-dependent), selects greedily with no
  diversity, and builds its profile block from an unbounded actor scan on every request.
- **API keys are not scoped to a tenant.** Any valid key reaches every tenant. Multi-tenancy
  protects against accidents, not against a hostile caller holding a key.
- **The rate limiter is per-process** and `trust proxy` is not enabled, so it is decorative
  behind more than one replica or any reverse proxy.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — what is structurally wrong with the current
  design and the target shape. **Start here.**
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) — every harness, metric definitions, full results.
- [`bench/README.md`](bench/README.md) — synthetic dataset design and label integrity.
- [`docs/providers.md`](docs/providers.md) — provider internals and scoring formulas.
- [`docs/WORKING_OVERVIEW.md`](docs/WORKING_OVERVIEW.md) — the write path and the read path.
- [`docs/INTEGRATION_GUIDE.md`](docs/INTEGRATION_GUIDE.md) — integrating from an application.
- [`docs/deployment.md`](docs/deployment.md) — running it, and the limits before you do.
- [`src/integrations/README.md`](src/integrations/README.md) — MCP and agent frameworks.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — tests, benchmarks, adding a provider.

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Campaign Layer.
