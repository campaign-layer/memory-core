# Architecture: what's wrong and where we're going

Status: active plan. Written after an audit that verified every claim below by running the code.

## Status update

The problem list below was accurate when written. Several items have since been
fixed, and benchmarking against public datasets changed the priority order. What
follows is the current state; the original analysis is kept intact underneath
because the reasoning still explains *why* the design was wrong.

### Agent-outcome gate (2026-08-31)

A fresh local Kimi architecture/experiment review returned **MODIFY — evidence gap**. The
repository demonstrates retrieval regressions, pinned L0/L1/L2 framework integration and a
fault-qualification harness, but no autonomous L3 result or causal O1/O2 task uplift. The
reviewed experiment matrix and pass gates are in
[`AGENT_EVALUATION.md`](./AGENT_EVALUATION.md).

The resulting architecture priorities are: immutable evidence plus series/version/current-
head CAS; explicit contradiction/conflict state; calibrated `answerable | abstain | conflict`;
auditable memory-use-to-outcome attribution; and role-scoped writes. A graph projection can
support multi-hop retrieval, but it must remain rebuildable and cannot become the authority
for truth, visibility, task leases or coordination.

**Fixed or verified**

| Was | Now |
|---|---|
| `pruneExpired()` full scan on every read | Lazy `isVisible()`; `getById` at 50k records went 17,395ms → 1.0ms per 2000 calls |
| O(N) dedupe per observation | Normalized-text index; `findDuplicate` 30,121ms → 3.0ms, batch ingest 8,084ms → 83ms |
| `FileProvider` compacting on every read, rewriting per write | Compaction removed from reads, writes coalesced |
| No semantic retrieval reachable from config | `MEMORY_EMBEDDER` selects none/local/hash/voyage/openai; hybrid BM25+vector RRF in the in-memory and file providers, and pgvector HNSW now reachable for postgres |
| `processingTime: Date.now() - Date.now()` | Real timing via `performance.now()` |
| `MEMORY_PROVIDER=dual-layer` crashed at boot | Config enum derived from `MemoryProviderKind` |
| Dockerfile installed prod deps then ran `tsc` | Multi-stage build (note: PaaS builders that autodetect Node ignore the Dockerfile entirely) |
| Benchmark-overfit gazetteers and a hardcoded gold answer | Deleted; the string was verbatim LongMemEval question 1's answer |
| Scope hierarchy was decorative | Central visibility policy now enforces tenant/space/app/actor/thread semantics across providers and opaque-id mutations |
| Remote forget/supersede could only downrank | Provider-level scoped retirement plus REST get/status APIs now remove retired ids from every active read path |
| `buildContext` profile read was unbounded | `listVisible()` caps the provider scan at 1,000 records; relevance and caching remain open |
| `buildContext.maxChars` ignored profile/header output | The complete prompt is bounded; relevant evidence wins budget priority, profile duplicates are removed, and full emitted evidence carries id/scope/tenant/space/app/actor/event/source provenance |
| Valid tenant keys could impersonate any actor | Normal keys bind tenant/space/app/actor; tenant-wide identity assertion is an explicit admin grant and global keys are operator-only |
| Reranker existed only as dead retrieval scaffolding | Optional Voyage cross-encoder now reranks a bounded provider candidate set at the service seam with score gating and fail-open cooldown |

**Measured retrieval quality** (see `docs/BENCHMARKS.md` for commands)

| Dataset | BM25-only | Hybrid | Reference |
|---|---|---|---|
| LoCoMo, n=1,531, R@10 | 0.626 | **0.709** | mem0 OSS 0.694 |
| LoCoMo, n=1,531, R@1 | 0.332 | 0.344 | mem0 OSS **0.345** |
| LongMemEval, n=479, R@10 | 0.780 (bm25 baseline) | **0.802** (memory-core) | — |
| LongMemEval, n=479, R@1 | **0.362** (bm25 baseline) | 0.343 (memory-core) | — |

**What the numbers changed about the plan**

1. **The write path is confirmed as the gap, but "consolidation" is the wrong
   target.** Across 5,882 LoCoMo turns, mem0 emitted 3,164 memory events and
   **every one was `ADD` — zero `UPDATE`, zero `DELETE`.** Its advantage comes from
   *extraction and distillation*, not from the merge/supersede loop. So the
   Extractor (item 7 below) outranks the full Resolver (item 3) for closing the
   gap to mem0, even though the Resolver is still what fixes knowledge-update.
2. **RRF cannot express confidence, only rank.** An item found only by vector
   search at rank 1 scores `1/(k+1)` — identical to an item found only lexically at
   rank 1, at every k. A cosine of 1.000 therefore ties a mediocre lexical match.
   Magnitude-aware fusion (`linearFusion` in `src/retrieval/fusion.ts`) or a
   tie-break on best component score is the fix. Covered by a test.
3. **The default RRF constant was wrong for this workload.** k=60 comes from the
   literature and assumes TREC-scale candidate pools; lowered to 5 on evidence from
   three datasets, two of them public. k=5 wins recall@5/10/30, MRR and nDCG on all
   three. The recall@1 story does **not** replicate and is fixture-specific — it
   reverses sign on LongMemEval:

   | recall@1 | k=5 | k=60 |
   |---|---|---|
   | bench/ synthetic (n=44) | **0.489** | 0.352 |
   | LoCoMo (n=1,531) | **0.344** | 0.336 |
   | LongMemEval (n=142) | 0.346 | **0.353** |

   Paired tests on LongMemEval (n=142) are the strictest read available, and they
   narrow the claim further: recall@1 −0.007 (ns — only **one** question ranked
   differently at all), recall@5 +0.019 (ns), recall@10 +0.007 (ns), and
   **recall@30 +0.031, t=2.65, significant, 9 wins / 0 losses**.

   So the honest justification for k=5 is "deeper recall improves and nothing
   regresses", not "recall@1 improves". The +13.7pt recall@1 figure from the
   synthetic suite must never be quoted as a general property.

   The same paired analysis shows the far bigger effect is **hybrid vs BM25-only**:
   recall@5 +7.3, recall@10 +6.5, recall@30 +7.2 (all significant), meanRank
   27.2 → 5.7 — with recall@1 **unchanged** (+0.0006, ns). Hybrid retrieval buys
   recall depth, not top-1 precision. It costs 26.5s/question of embedding against
   45ms for BM25-only.

6. **Hybrid retrieval fixes the preference blind spot, confirmed on public data.**
   `single-session-preference` is the worst slice for lexical retrieval on
   LongMemEval — bm25 scores recall@5 0.300 against 0.65–0.92 on every other slice,
   with gold outside the top 100 for 23% of those queries. Hybrid lifts it to 0.667
   at k=5. That independently replicates the synthetic suite's preference family
   going 0.0% → 66.7%, which was the finding that motivated wiring the embedder.
4. **Event time is not decay time.** `service.ingest` set `lastSeenAt` from
   `observedAt`, so any import older than the 180-day default TTL expired on
   arrival while `ingest` returned `created=1` — silent loss behind a success
   response. Fixed; `firstSeenAt` keeps event time.
5. **QA-style scoring is weak evidence on LoCoMo.** With gold evidence supplied
   directly, the oracle scores only 0.485, so the answering step dominates and all
   retrieval systems compress under a low ceiling. Rank metrics are the signal.

**Still open** — Problems 1, 2, 4, 6 and 9 below stand substantially as written:
four ranking implementations still exist (no `MemoryStore`/`Retriever` split), the opt-in
Extractor is unmeasured and there is no Resolver, only explicit lifecycle tools/API calls set
`superseded`, `buildContext` still budgets in characters rather than model tokens with MMR unwired,
tenant scope is still a filter argument rather than a structural handle, and there is no
learning loop. Retrieval is now hybrid and can be cross-encoder reranked, but remains
single-shot: no multi-hop.

## Reviewed production target (2026-08-29)

Status: **proposed; production release remains blocked**.

This design incorporates the current benchmark and sandbox evidence plus one completed local
Kimi architecture turn. Kimi returned **MODIFY**: retain the ledger plus bounded relation
projection, but do not let a rebuildable projection decide prompt visibility or truth; narrow
the uniqueness claim to one exact visibility tuple; define bitemporal precedence, legacy
collision handling, and the file crash boundary. Those changes are incorporated below.
Updated on 2026-08-31: the user authorized a sanitized frozen-source export. Kimi completed
the agent-outcome architecture/experiment review with **MODIFY — evidence gap**; this is not
source-code or production sign-off.

### Complete current gap register

| Priority | Current gap | Required invariant |
|---|---|---|
| P0-A closed | Configured server defaults to loopback and rejects an unauthenticated non-loopback bind | Preserve the startup matrix and its production-mode tests |
| P0-A closed | `MemoryCoreClient` now rejects redirects, bounds the whole response and body, and requires HTTPS except loopback | Preserve redirect/deadline/body/URL tests |
| P0-A containment | Extractor exceptions and successful no-facts windows are distinctly labelled and excluded from prompts by default | Replace V1 containment with durable V2 evidence/candidate state |
| P2 partial | PostgreSQL exact-text dedupe is atomic; service batches can still partially commit and non-Postgres providers use the portable service path | Persisted idempotency plus one all-or-nothing store command |
| P2 | Remote supersede is create → feedback → retire across requests | One compare-and-swap revision transaction |
| P2 | Extracted facts retain transient turn indexes but not durable source text/spans | Every accepted version links to immutable evidence ids and hashes/spans |
| P2 | Direct provider `getById` can be called without a scope | Every store operation requires a resolved access context |
| P0-A closed | Hosted model transports clamp `Retry-After`, reject redirects, bound bodies, and share one deadline across fetch/body/retry sleep | Preserve adversarial transport tests |
| P2 | Migration 002 performs a full backfill and non-concurrent index builds in one rollout transaction | Expand/migrate/contract; heavy work runs in a dedicated migrator |
| P2 | Benchmark artifacts omit or contradict SHA/dirty/provider/RRF configuration | Release artifacts carry a complete, clean, reproducible manifest |
| Quality | Large context regression selected stale evidence and leaked on every abstention case | Search current accepted heads; return explicit answerable/abstain/conflict state |
| Quality | Profiles are recency slices; a live sandbox omitted a relevant Caddy instruction from `profileSummary` | Structured profile items are authoritative and render deterministically |
| Quality | Corrected instructions can silently fall back to confidence `0.7` and a 180-day TTL | Revisions inherit load-bearing fields unless explicitly changed |
| Reliability | File storage has no multi-process writer exclusion | Refuse a second writer; crash-safe atomic snapshots; never distributed file mode |
| Operations | No durable audit sink, fleet quota, metrics/tracing, restore drill, or multi-replica soak | Transactional mutation audit plus shared quota/telemetry and proven recovery |
| Breadth | No mature automatic profiles, multimodal ingestion, connectors, or consolidation | Defer breadth until correctness and held-out quality gates pass |

Documentation/CI hygiene is part of P0 rather than architecture: the readiness quickstart,
package import paths, MCP verification coverage, and benchmark provenance must stay executable
from a clean checkout.

### Decision: relational evidence ledger, not a general graph

The smallest coherent design is a deterministic state machine around four durable concepts:

1. **Observation:** immutable source evidence received from a user, tool, import, or agent.
2. **Series:** stable logical identity and visibility boundary for one evolving memory.
3. **Version:** immutable accepted content for one revision of a series.
4. **Current head:** one transactionally maintained pointer to the version used by normal
   retrieval.

An optional narrow relation projection may record `supports`, `contradicts`, `duplicates`,
and `derived_from`. It is rebuildable and never authoritative for access, current-head
selection, conflict suppression, quarantine, or prompt admission. Predecessor revision plus
the head event are the authoritative supersession record; durable resolution decisions are
the authoritative conflict/admission record. This is not a graph database, ontology, or
license for an LLM to rewrite truth. Similarity may propose a relation; only a validated
command may record a decision or advance the current head.

```text
Agent surfaces: Claude / Codex / Hermes / REST / SDK
                         │
               authenticated gateway
          credential → ResolvedAccessContext
                         │
              ┌──────────┴──────────┐
              │                     │
       command/write path      query/read path
 evidence → candidate →        current accepted heads
 validate → resolve →          → BM25 ∥ ANN → fuse
 atomic commit + outbox        → optional rerank
              │                → truth decision
              └──────────┬──────────┘
                         │
       Postgres: evidence · series · versions · heads
       relations · idempotency · audit/outbox · projections
```

Postgres remains the production store. In-memory implements the same command semantics under
one mutex for tests. File mode uses one process lock and copy-on-write snapshot publication:
write one complete temporary snapshot containing heads, operations, and outbox, fsync it,
atomically rename it, then fsync the parent directory. Recovery observes the complete old or
new snapshot, never a mixture. It is a local single-writer option, never a multi-replica
database.

### Storage contract

The expand-only V2 schema should contain:

- `memory_observations`: principal, source event/session, observed/received time, immutable
  content hash, optional encrypted content or immutable source URI, and assertion kind;
- `memory_series`: immutable tenant/space/app/actor/thread/scope/type coordinates,
  collision-safe visibility key, state, revision counter, and current version id;
- `memory_versions`: series id, revision, text/summary, effective and recorded time,
  confidence, importance, decay policy, and creating principal;
- `memory_version_evidence`: version ↔ observation links with source hash and optional spans;
- optional `memory_relations`: the bounded, rebuildable relation vocabulary above,
  version-aware where necessary;
- `memory_resolution_decisions`: authoritative admit/quarantine/reject/conflict decisions,
  policy version, inputs, reason codes, and deciding principal or deterministic rule;
- `memory_head_events`: append-only created/revised/retired transitions for audit and `asOf`;
- `memory_candidates` plus extraction jobs: pending/quarantined/rejected derived output;
- `memory_operations`: `(tenant, principal, idempotencyKey)` plus request hash, operation id,
  stored response, state, and expiry;
- an audit/outbox record committed in the same transaction as each mutation.

Embeddings attach to immutable `versionId`, not the logical series. Normal retrieval indexes
only current, accepted, non-expired heads. A unique active-content constraint over one exact
visibility tuple, memory type, and normalized content hash closes only the same-scope
concurrent exact-dedupe race. It does not merge actor/app/workspace/tenant copies; any
cross-scope promotion or merge requires an explicit policy command and auditable decision.

### Access and transport contract

`ResolvedAccessContext` is created from the authenticated credential at the gateway and is a
mandatory argument to every store command/query. Normal principals cannot assert a different
tenant, space, app, or actor; they may select only a narrower thread. The provider interface
has no optional-scope id read.

The fail-closed startup matrix is:

- default `HOST=127.0.0.1`;
- production requires Postgres, an explicit database URL, at least one credential, and
  application auto-migration disabled;
- a development-only insecure-listen override may permit a non-loopback unauthenticated bind
  after an explicit warning; production rejects that override;
- no developer-specific Postgres URL fallback;
- `/health` and `/ready` stay minimal, while authenticated operations status carries detailed
  degradation counters.

The SDK now defaults to `redirect: "error"`, a 10-second total deadline, and a 1 MiB response
limit. It rejects credentials in the URL and plain HTTP outside loopback and currently does
not retry implicitly. Hosted model transports use bounded retries and clamped `Retry-After`
under one deadline. Future V2 mutations may be retried only with an idempotency key.

### Atomic command API

Provider-level `findDuplicate → ingest/update` composition becomes one command boundary:

```ts
interface MemoryStore {
  execute(
    access: ResolvedAccessContext,
    command: IngestBatch | ReviseMemory | RetireMemory | RecordFeedback,
  ): Promise<MutationResult>;

  get(access: ResolvedAccessContext, seriesId: string): Promise<MemoryView | null>;
  search(access: ResolvedAccessContext, query: SearchCommand): Promise<SearchResult>;
}
```

`POST /v2/memory/batches` requires `Idempotency-Key`. The same key and request hash returns
the exact stored response; the same key with a different hash returns 409. Atomic batches
expose only all observations or none.

`POST /v2/memory/series/{seriesId}/revisions` requires `Idempotency-Key` and
`If-Match: <currentVersionId>`. In one transaction it locks the series, verifies the head,
adds direct evidence if needed, inserts version N+1 with its predecessor, inherits omitted
confidence/importance/decay, appends the head event, changes the head, writes audit/outbox,
and commits. Optional relation projections are derived after the authoritative commit.
Tenant, visibility scope, actor, and memory type cannot change during revision. Two concurrent
revisions against one head yield one success and one 409, never two active truths.

### Extraction trust boundary

Raw turns and extracted claims are different inputs:

- explicit atomic observations from an authorized caller may enter validation directly;
- raw turns are immutable evidence and create an asynchronous extraction job;
- extracted output starts as a candidate, not a memory;
- admission requires durable evidence, scope no broader than every source, grounding/schema
  checks, and type-specific policy;
- extractor failure records `retryable_failed` or `terminal_failed` and produces no
  prompt-visible version;
- derived shared `instruction` memories require direct assertion or administrator approval.

LLM extraction never runs inside the database transaction. Persist evidence first, extract
outside the transaction, then admit a validated candidate through the same idempotent command
path.

### Current truth, abstention, and profiles

The read path filters to current accepted heads before lexical/vector retrieval. An explicit
revision wins within a series; late historical evidence does not silently replace the head;
unresolved contradictory series return `conflict`; similarity alone cannot rewrite state.
Bitemporal reads expose distinct `recordedAsOf` and `effectiveAsOf` parameters. Recorded time
selects the head-event history known to the system at that instant; effective time then
filters validity within that recorded snapshot. Revision order is authoritative for the
head, so a late observation with an older effective time cannot silently advance it.

V2 context returns a decision independent from retrieval rank:

```json
{
  "decision": {
    "status": "answerable",
    "confidence": 0.91,
    "policyVersion": "resolver-v1",
    "reasonCodes": ["current_head", "direct_evidence"]
  },
  "items": [{
    "seriesId": "...",
    "versionId": "...",
    "evidenceIds": ["..."],
    "placement": "relevant",
    "text": "..."
  }],
  "omissions": []
}
```

Status is `answerable`, `abstain`, or `conflict`. Thresholds are frozen on a calibration
split before held-out evaluation; the max-normalized retrieval score is never reused as truth
confidence.

Profiles are structured current-head projections. Stable ordering is section priority,
importance, effective time, then series id. The prose summary renders from exactly the
returned items, every sentence maps to a series/version, and every omitted eligible item has
a reason such as `budget`. V1 `profileSummary` is generated from the same item set during
compatibility; free-standing prose is not authoritative.

### Migration and delivery order

**P0-A — immediate security/correctness**

- **Implemented:** fail-closed startup/production matrix; SDK redirect, HTTPS, deadline and
  body bounds; hosted retry/`Retry-After` bounds; extraction failure/no-facts prompt
  quarantine; quickstart and MCP CI verification.
- **Still open:** provider id access scoped in the new store contract and clean benchmark
  manifests required by release automation.

**P0-B — transactional mutation core**

- expand-only V2 tables, dedicated heavy-data migrator, persisted idempotency;
- atomic batch ingest and single-call CAS revision;
- file single-writer lock and crash-safe snapshot;
- MCP/Hermes supersede moved to the revision endpoint.

**P0-C — compatibility cutover**

- route V1 writes through V2 commands;
- backfill each legacy record as one series/version with synthetic `legacy_import` evidence,
  explicitly marking original evidence unavailable rather than inventing it;
- deterministically group legacy collisions before enabling the active-content uniqueness
  constraint: preserve every row as evidence, select a head by explicit status then
  `lastSeenAt`, `createdAt`, and stable id, and emit an auditable reconciliation decision;
- preserve the legacy id as `seriesId`, add `versionId`, shadow-read and compare visibility/
  ranking/context, then switch reads and stop legacy writes.

**P1 — temporal quality and operations**

- relation candidates, deterministic conflict policy, structured profiles, calibrated
  abstention, shared quotas, authenticated metrics/audit export;
- multi-replica fault injection, rolling migration, backup/PITR restore and audit-continuity
  drills;
- held-out MemoryBench/LongMemEval-V2/PersonaMem/action benchmarks.

### Release tests and quantitative gates

P0 must include a startup auth/bind matrix; cross-origin redirect trap; adversarial
`Retry-After`; concurrent idempotency replay/conflict; 100-way exact dedupe; fault injection
at every batch boundary; disconnect-after-commit replay; competing CAS revisions; extractor
throw/no-facts separation; derived-scope narrowing; mandatory scoped reads; file second-writer
and fsync crash recovery; and REST/MCP principal-credential CI.

P1 gates:

- explicit revisions have 0% stale selection; natural temporal stale selection ≤5%;
- held-out unanswerable false-positive rate ≤10% while retaining ≥90% answerable cases;
- every context item has durable evidence and no raw/quarantined item enters a prompt;
- profile output is permutation-invariant and each omission is explained;
- LoCoMo regression is less than one point from R@10 0.709 and R@30 0.817;
- restore reconstructs every head/evidence edge; multi-replica mutation, quota and audit chaos
  passes.

Every benchmark artifact records clean SHA, dirty flag, dataset hash, command, provider,
embedder/model/dimensions, RRF/fusion settings, thresholds, reranker/extractor versions, and
failure/fallback counters.

### Deliberately deferred

Do not build multimodal storage, a connector marketplace, a general knowledge graph, a
separate vector database, autonomous generative profiles, learned truth resolution, complex
episode consolidation, or distributed file storage before the P0/P1 invariants pass. These
features broaden a system whose present failures are correctness failures; they do not fix
them.

## 2026 north star

This is a direction, not a claim that paper scores are comparable to our harness. Current
systems point to a memory pipeline that is materially richer than flat top-k retrieval:

- **Keep evidence distinct from inference.** Raw observations and agent experiences should be
  immutable evidence; entity summaries and beliefs should be derived, revision-linked, and
  explainable back to that evidence. [Hindsight](https://arxiv.org/abs/2512.12818) makes this
  separation explicit across world facts, experiences, summaries, and evolving beliefs.
- **Make time and consolidation first-class.** Atomic traces need event time, validity time,
  and relationships to thematic scenes and profiles rather than destructive replacement.
  [EverMemOS](https://arxiv.org/abs/2601.02163) describes a trace → scene → reconstructive
  recollection lifecycle.
- **Keep fresh evidence queryable while maintenance runs asynchronously.** Extraction can be
  parallel, while summaries refresh only along dirty hierarchical paths; the foreground write
  should not wait for a global reorganization. [MemForest](https://arxiv.org/abs/2605.23986)
  treats this as a temporal data-management problem.
- **Evaluate experience, not only remembered chat facts.**
  [LongMemEval-V2](https://arxiv.org/abs/2605.12493) covers state, workflows, environment
  gotchas, and false-premise awareness over agent trajectories;
  [PersonaMem-v2](https://arxiv.org/abs/2512.06688) targets preferences that are mostly
  implicit rather than directly stated.

The implementation sequence follows from those constraints:

1. Finish access, durability, migration, and observability contracts; quality work on an
   unsafe substrate is not shippable.
2. Add an evidence ledger plus Resolver: `derivedFrom`, `supersedes`, valid-time intervals,
   contradiction candidates, and atomic revision commits. Never discard source evidence.
3. Move extraction and consolidation behind an idempotent queue/outbox. Make atomic memories
   visible immediately; refresh entity/profile/scene projections asynchronously and locally.
4. Split `MemoryStore` from retrieval. Add temporal/entity expansion, calibrated candidate
   scoring, a reranker, token-aware diverse context selection, and evidence citations.
5. Gate releases on end-to-end `buildContext` evaluation: current synthetic/LoCoMo/
   LongMemEval, then LongMemEval-V2 and implicit-persona slices, with stale-answer rate,
   abstention, isolation, freshness latency, throughput, cost, and recovery tests.
6. Build on the tenant-bound credential edge with audit events, distributed quotas,
   metrics/tracing, backups, restore drills, and multi-replica soak tests before calling the
   service production-ready.

## Thesis

**memory-core is built as a key-value store with a scoring function bolted on. A memory system is a pipeline problem.**

The value of a memory system is not in storage, and not in any single ranking formula. It is in two places:

1. **The write path** — deciding what is worth writing down, and reconciling it against what is already known.
2. **Staged retrieval** — cheap wide recall, then expensive precise ranking over a small candidate set.

The current design has nowhere to put either. `MemoryProvider.search()` is one function that must do everything, so every backend reinvents everything and none of it composes.

---

## Problem 1 — The provider interface conflates storage with ranking

`src/provider.ts` puts persistence (`ingest`, `update`, `getById`, `listByActor`) and retrieval (`search`) behind one interface. So every storage backend must reimplement ranking from scratch. We now have four independent, mutually-incompatible, all-poor scoring functions:

The formulas below are as they stood at audit time; `in-memory` and `dual-layer`
have since been rewritten (see the status update above). The structural point is
unchanged — there are still four separate ranking implementations.

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

## Problem 10 — Deployment (historical finding)

The original `Dockerfile` ran `npm ci --only=production`, then `npm run build` (tsc), although
the compiler and type packages were devDependencies. That build failure is fixed by the
multi-stage image described in the status table above. Remaining gaps include per-process
rate limiting, dependency-audit release blockers, and no CI.

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
