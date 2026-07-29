# Architecture: what's wrong and where we're going

Status: active plan. Written after an audit that verified every claim below by running the code.

## Thesis

**memory-core is built as a key-value store with a scoring function bolted on. A memory system is a pipeline problem.**

The value of a memory system is not in storage, and not in any single ranking formula. It is in two places:

1. **The write path** — deciding what is worth writing down, and reconciling it against what is already known.
2. **Staged retrieval** — cheap wide recall, then expensive precise ranking over a small candidate set.

The current design has nowhere to put either. `MemoryProvider.search()` is one function that must do everything, so every backend reinvents everything and none of it composes.

---

## Problem 1 — The provider interface conflates storage with ranking

`src/provider.ts` puts persistence (`ingest`, `update`, `getById`, `listByActor`) and retrieval (`search`) behind one interface. So every storage backend must reimplement ranking from scratch. We now have four independent, mutually-incompatible, all-poor scoring functions:

| Implementation | Formula |
|---|---|
| `in-memory-provider.ts:29` | `overlap*0.55 + recency*0.15 + confidence*0.15 + importance*0.1` |
| `enhanced-provider.ts:569` | four different weight sets selected by regex query class |
| `dual-layer-provider.ts:411` | `jaccard * confidence * importance` |
| `file-provider.ts` | inherits in-memory's |

None of them has IDF. An improvement to one improves nothing else. Adding the Postgres backend would have created a fifth.

**Fix:** split into `MemoryStore` (persist + generate candidates) and `Retriever` (rank + fuse + rerank). Ranking gets implemented once.

---

## Problem 2 — There is no write path

`service.ts:90` does: normalize → `findDuplicate` → insert. That is the entire write path. What is missing is the part that makes a memory system work:

- **Extraction.** The API accepts an already-formed `MemoryObservation`. So the caller must pre-digest raw conversation into atomic memory statements. memory-core is not a memory system today; it is a typed text store. Agents that dump raw turns in will get garbage out.
- **Resolution.** `findDuplicate` compares `record.text.toLowerCase() === candidate.text.toLowerCase()` (`in-memory-provider.ts:78`). Exact string equality. So "I live in Lisbon" and "I moved to Berlin last month" both persist as active, contradictory, and permanently retrievable. This is the single biggest reason memory systems feel broken to users.
- **Supersession.** `MemoryStatus` includes `"superseded"` and `DecayPolicy` exists — but **nothing in the codebase ever sets `superseded`**. Every provider returns `archivedSuperseded: 0` as a literal. The type system describes a lifecycle the code never implements.
- **Provenance.** `extractedFrom` exists only inside dual-layer's private interface, never in `MemoryRecord`. Consolidated memories cannot be traced to their sources.

**Fix:** a real pipeline — `extract → embed → resolve → commit → consolidate` — with each stage a swappable strategy.

---

## Problem 3 — Retrieval is single-stage and single-shot

Every provider scores every record linearly, sorts, slices. Consequences:

- **No candidate/rerank split.** The right shape is: recall ~200 cheaply, then rerank those precisely. A single `search()` cannot express this, so we can never afford a cross-encoder.
- **No multi-hop.** Questions needing two joined facts across sessions require retrieve → read → retrieve again. Inexpressible through one `search()` call.
- **Query understanding is regex.** `classifyQuery` (`enhanced-provider.ts:343`) pattern-matches on `first|second|last|before|after`. No expansion, no HyDE, no multi-query.
- **Uniform decay.** Recency uses a fixed 30-day half-life for all memory types (`utils.ts:57`). A durable preference decays exactly like a throwaway episode. `DecayPolicy` is per-record, but recency *weighting* ignores it.

**Fix:** an explicit staged pipeline — `candidates (BM25 ∥ ANN) → fuse (RRF) → rerank → diversify (MMR)` — with an iterative mode for multi-hop.

---

## Problem 4 — `buildContext` is the most-used endpoint and the least developed

This is what agents actually call. `service.ts:180`:

- Prepends a "profile summary" from `getProfile()`, which takes **the first 3 memories of each type ordered by recency** (`service.ts:70`) — not by relevance to the query. Context gets padded with arbitrary memories.
- `getProfile()` calls `listByActor()`, which returns **every record for the actor, unbounded**, on **every context build**. This is the single worst performance bug in the system.
- Greedy selection in score order with no diversity, so five near-duplicates can consume the whole budget.
- Budget is counted in **characters**, not tokens — off by roughly 4x and model-dependent.
- Output is a flat list. No separation of stable profile / task-relevant facts / recent episodes.

**Fix:** token-aware budgeting, MMR diversity, structured sections, and a ranked+capped profile instead of recency slices.

---

## Problem 5 — Performance: concrete costs

Ranked by real-world impact. N = records in store.

1. **`pruneExpired()` makes every read O(N).** It iterates the entire store and is called at the top of `search`, `findDuplicate`, `listByActor`, `getById`, and `applyFeedback`. So `getById` — a hash lookup — is a full scan.
2. **`FileProvider` rewrites the whole JSON file on every write.** `persist()` serializes all records on each `ingest`/`update`/`applyFeedback` (`file-provider.ts:48`). O(N) disk write per write op ⇒ O(N²) to load a dataset.
3. **`FileProvider` runs `compact()` on every read.** `persistIfCompacted()` is called from `search`, `getById`, and `listByActor` — a second full scan per read.
4. **Batch ingest is O(N²).** `service.ingest` loops observations sequentially, awaiting an O(N) `findDuplicate` for each.
5. **`buildContext` does a full actor scan** via `getProfile` → `listByActor`, per request (see Problem 4).
6. **`dual-layer` consolidation is O(n²) per actor**, on a 30s timer, unbounded (`dual-layer-provider.ts:345`).
7. **No ANN index anywhere.** `enhanced-provider` computes 384-dim dot products against every record in JS.
8. **Unbounded caches.** dual-layer's `cache`/`lastCacheUpdate` grow without a size limit; eviction only happens on the 30s timer and only for expired keys.
9. **`setInterval` without `unref()`** in `DualLayerMemoryProvider` and `OptimizedMemoryCoreService` constructors — keeps the event loop alive, leaks per instance, blocks graceful shutdown.

---

## Problem 6 — Multi-tenancy is advisory, not structural

`tenantId` is a filter argument. Every provider re-implements the check, and dual-layer gets it wrong: `matchesFilters` guards with `if (filters.tenantId && ...)` and returns `true` when `filters` is absent, so a library caller passing `{}` receives everything. One missed check anywhere is a cross-tenant leak.

**Fix:** hand callers a `TenantScope` handle rather than a filter bag, so an unscoped query is unrepresentable.

---

## Problem 7 — No observability; the metrics that exist are fake

- `service.ts:246`: `processingTime: Date.now() - Date.now()` — always 0.
- `optimized-service.ts` computes EMA latency/cache/error metrics and is **dead code** — 657 lines imported by nothing, while the README's architecture diagram lists it as a live request-path layer.
- `reasons: string[]` is decorative prose, not component scores. You cannot answer "why was this ranked first".

**Fix:** per-stage spans with real component scores attached to each hit.

---

## Problem 8 — The type system lies

- `MemoryType` has 10 values; `http.ts:14` accepts 8; `getProfile` handles 10; `optimized-service`'s profile stub handles 6.
- `MemoryScope` declares a 5-level hierarchy (`thread|actor|workspace|app|tenant`) but no scope *resolution* exists — a `workspace` memory is invisible unless explicitly filtered for. The hierarchy is decoration.
- `MemoryProvider.ingestObservations?` and `buildContext?` are optional interface members implemented by no provider.
- `HealthStatus` and `ProviderHealthStatus` are two competing shapes; only the latter is used.

---

## Problem 9 — No learning loop

`applyFeedback` increments three counters that feed a ±0.12 score nudge. That is the whole loop. Missing: which memories contributed to successful outcomes, adaptation of retrieval strategy, and distillation of episodes into reusable patterns — the `pattern` memory type exists but nothing ever produces one.

---

## Problem 10 — Deployment

`Dockerfile` runs `npm ci --only=production`, then `npm run build` (tsc) — but `@types/node` and `@types/express` are devDependencies, so the build cannot succeed. The rate limiter is per-process, so it is decorative behind more than one replica. No CI exists.

---

## Target architecture

```
                    ┌──────────── Agent surfaces ─────────────┐
                    │   MCP  ·  REST  ·  SDK  ·  tool-schemas │
                    └───────────────────┬─────────────────────┘
                                        │
                                MemoryCore (facade)
                                        │
     ┌────────── WRITE PATH ────────────┴──────────── READ PATH ─────────────┐
     │                                                                       │
 Extractor          Resolver                 Retriever                ContextBuilder
 turns → atomic   dedupe / refine /     ┌ candidates: BM25 ∥ ANN ┐    token budget,
 statements       contradict /          ├ fuse: RRF              │    MMR diversity,
     │            supersede             ├ rerank: cross-encoder  │    structured
 Embedder              │                └ diversify: MMR         │    sections
     │                 │                          │                        │
     └─────────────────┴────────────┬─────────────┴────────────────────────┘
                                    │
                        MemoryStore — persistence + candidate generation ONLY
                          ├─ PostgresStore (tsvector FTS + pgvector HNSW)
                          └─ MemoryStore   (tests / embedded)

 Async:  Consolidator — episodes → patterns, decay, supersession GC
 Cross-cutting:  TenantScope (structural)  ·  Telemetry (per-stage spans)  ·  FeedbackLoop
```

### The six structural moves

1. Split `MemoryProvider` into `MemoryStore` + `Retriever`. Ranking implemented once.
2. Add a write pipeline with `Extractor` and `Resolver`. Resolution is where knowledge-update correctness comes from.
3. Make retrieval staged and instrumented; add an iterative mode for multi-hop.
4. Rebuild `buildContext`: token-aware, diversified, structured.
5. Make tenant scope structural, not a filter argument.
6. Add real telemetry with component scores.

---

## Sequencing

Ordered by value per unit of risk. Effort assumes the retrieval primitives (BM25, embedders, RRF, MMR) and the Postgres store already exist.

| # | Work | Why now | Effort |
|---|---|---|---|
| 1 | Kill the O(N) read path: drop `pruneExpired` from hot reads, make decay lazy/indexed, stop `FileProvider` full-rewrites and per-read compaction | Pure win, no interface change, unblocks honest benchmarking | 2-3 h |
| 2 | `MemoryStore` / `Retriever` split; port existing providers behind it | Everything downstream depends on this seam | 4-6 h |
| 3 | `Resolver`: semantic dedupe, refine, contradict, real supersession | Fixes the worst *quality* failure (stale memories winning) | 4-6 h |
| 4 | `ContextBuilder` v2: token budget, MMR, structured sections, ranked profile | Highest-leverage endpoint for real agents | 3-4 h |
| 5 | Batch + parallelize the write path; index-backed dedupe | Removes O(N²) ingest | 2 h |
| 6 | Telemetry: per-stage spans, component scores, real `processingTime` | Makes every later change measurable | 2 h |
| 7 | `Extractor`: raw turns → atomic statements | Turns this into a memory system rather than a text store | 4-6 h |
| 8 | Multi-hop iterative retrieval | Unlocks the multi-session task family | 4 h |
| 9 | Learning loop: outcome attribution, episode → pattern distillation | The "learnings" requirement | 6-8 h |

Items 1, 2, 5, and 6 are the "code and performance" pass. Items 3, 4, 7, and 8 are the quality pass. Item 9 is the differentiator.

## Non-negotiables

- No domain-specific vocabulary in ranking code. The audit found gazetteers hardcoding benchmark answer keys; that class of code is banned.
- Every retrieval change is measured against the harness in `bench/`, including the random-ordering control, before and after.
- No claim ships without a reproducible command that produces the number.
