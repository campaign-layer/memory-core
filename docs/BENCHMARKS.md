# Benchmarks

How retrieval quality in this repo is measured, and the current numbers.

The harness is [`bench/`](../bench/README.md). Read that file for dataset design, the six
task families, and the label-integrity checks. This file is the results view.

## Read this first

Every number on this page comes from **`memory-core-internal-retrieval` v1.0.0 (MCIR)** — a
**synthetic dataset authored inside this repository**.

- **It is NOT LongMemEval. It is NOT LoCoMo.** It is not MemGPT's suite or any other
  published benchmark. Numbers here are **not comparable** to published scores on those
  suites and must never be presented as if they were.
- **LongMemEval has never been run in this repo.** A previous version of the README claimed
  "27.9% accuracy on LongMemEval" for the `enhanced` provider. That number was invalid: the
  provider hardcoded that benchmark's gold answers — `extractIntelligentAnswer()` returned
  the literal string `"GPS system not functioning correctly"`, and entity gazetteers
  hardcoded answer keys. It measured answer injection, not retrieval. The code is deleted and
  the number is retracted. It has not been replaced by a different LongMemEval number,
  because there is no LongMemEval run to replace it with.
- **The corpus is ours, and that is a real limitation.** A dataset we authored could
  unintentionally favour our own systems. Treat any cross-system gap here as a hypothesis to
  confirm on an external suite.
- **What it does prove:** given one corpus and one query set, whether system A ranks the
  correct memory above system B, and whether either is distinguishable from a random ordering
  or from plain lexical matching.
- **What it does not prove:** that anything here is good. A high score is necessary and
  nowhere near sufficient. It measures nothing about natural-language variety, real user
  phrasing, multilingual text, long documents, or end-to-end answer quality.

## Reproducing

```bash
npx tsx bench/run.ts --systems=random,bm25,in-memory,file,enhanced,dual-layer,naive-rag --size=small --k=10
npx tsx bench/run.ts --systems=supermemory --size=small --k=10   # needs SUPERMEMORY_API_KEY
```

npm script equivalents:

```bash
npm run bench            # tsx bench/run.ts, default system set
npm run bench:small      # --size=small -> bench/out/baseline-small.json
npm run bench:large      # --size=large -> bench/out/baseline-large.json
npm run bench:dataset    # regenerate fixtures deterministically
npm run bench:typecheck  # currently fails; see the note at the end
```

`bench/run.ts` generates the fixture if it is missing, so a bare run works from a clean
checkout. Fixtures are committed, and the same `--size` + `--seed` produces a byte-identical
file: all randomness comes from a seeded PRNG, and timestamps are stored as relative offsets
resolved against `--time-anchor` at run time.

### Provenance of the numbers below

| field | value |
|---|---|
| dataset | `memory-core-internal-retrieval` v1.0.0 (**synthetic, authored in this repo**) |
| fixture | `bench/dataset/generated/small-seed1337.json`, hash `8c0cbec5d2f8aded` |
| seed / size | 1337 / `small` |
| corpus | 527 memories, 17 sessions, 50 items |
| roles | 52 gold, 8 superseded, 253 hard-negative, 214 filler |
| queries | **n = 44 answerable**, plus 6 unanswerable scored separately |
| families | single-hop 12, temporal 10, multi-session 8, knowledge-update 8, abstention 6, preference 6 |
| retrieval depth | 100 for every system (`src` providers hard-cap `search` at 100) |
| embedder | requested `hash`, resolved `src:hash-bow-512` |
| time anchor | `2026-07-29T00:00:00.000Z` |
| git | `7f90586` (tree dirty) |
| node / platform | v22 / darwin |

All eight systems come from **one harness, one corpus, one metric definition** — every system
goes through the same `ingest → search` path. Provider-backed systems are searched with
`minScore: 0` so ranking metrics measure ranking rather than an arbitrary cutoff.

## Metrics

Defined in `bench/metrics.ts`. Design rule: no metric here can be maximised by returning
everything, and none can look good on a ranking that carries no information.

- **`recall@k`** (k = 1, 5, 10) — fraction of an item's gold memories inside the top k,
  averaged per item (partial credit).
- **`allGold@k`** — fraction of items where *every* gold memory is inside the top k. This is
  the honest number for `multi-session`, where partial-credit `recall@1` caps at 0.5 by
  construction.
- **`MRR`, `nDCG@10`** — binary gains; ideal DCG has all gold packed at the top.
- **`meanRank`** — best gold rank. Gold that is never retrieved is charged `corpusSize + 1`,
  so failing to return gold cannot hide behind a good average.
- **`foundRate`** — fraction of items where gold appeared anywhere in the returned ranking.
- **`staleRate`** (knowledge-update only) — fraction of items where a superseded memory
  outranked the current one. Both records are ingested `status: "active"` and nothing is
  pre-marked; detecting the update is the system's job.
- **Latency** — mean/p50/p95 per operation, reported in a separate table from quality, with
  network-bound systems flagged.

The `random` control always runs, even if omitted from `--systems`. The runner also prints the
closed-form baseline for the corpus and shouts `!! AT/BELOW RANDOM` at any system that fails
to clear it.

## Overall results

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

Analytic random baseline for this corpus (527 memories, depth 100): `E[R@1] = 0.19%`,
`E[R@5] = 0.95%`, `E[R@10] = 1.9%`, `E[meanRank] = 423.9`, `E[MRR] = 0.0115`.

`file` matching `in-memory` exactly is expected: `FileProvider` inherits its scoring.

### Systems

| name | what it is |
|---|---|
| `in-memory`, `file`, `enhanced`, `dual-layer` | the repo's providers, via `src/providers/factory.ts` |
| `bm25` | Okapi BM25 (k1=1.5, b=0.75), lexical only — no recency, priors, or embeddings |
| `random` | seeded-shuffle sanity floor |
| `naive-rag` | plain-RAG control: chunk session transcripts (400/100), embed, cosine top-k, nothing else |
| `supermemory` | live HTTP API adapter against `https://api.supermemory.ai` (v4, `searchMode=hybrid`) |

`postgres` is **not** in the harness. `bench/systems/index.ts` does not register it, so there
is no number for it — do not infer one from the rows above.

## Findings

**A plain BM25 lexical baseline beats every provider on `R@10` (92.0%).** No component in
this repo currently earns its complexity over Okapi BM25 with no recency weighting, no type
priors and no embeddings, on this dataset. `in-memory` buys 6.8 points of `R@1` and a better
`nDCG@10` for it, and loses 2.2 points of `R@10`.

**`enhanced` is the worst real system.** `R@10` 38.6%, `foundRate` 59.1% — for 41% of queries
the correct memory is not in the top 100 of a 527-memory corpus at all. Its `meanRank` of
222.4 is closer to the random control (407.2) than to BM25 (3.3). It is also the second
slowest, ~34x `in-memory`. This is the provider a previous README labelled "Production
Ready".

**Against live supermemory we tie at the ends and lose in the middle.** Identical `R@10`
(89.8%) and `R@1` (40.9%), but supermemory orders the mid-ranks better: `R@5` 80.7% vs
62.5%, `MRR` 0.662 vs 0.615, `nDCG@10` 0.688 vs 0.648. For an agent splicing the top 5 into a
prompt, that is the gap that matters and it is not ours. Supermemory's `foundRate` is 93.2%,
below our 100%, so its losses are concentrated in complete misses rather than bad ordering.

**`naive-rag` shows chunk-level retrieval is not enough.** `R@1` of 0.0% with `R@10` of 51.1%
is the signature of retrieving a chunk that contains the gold fact *and* its distractor at the
same score. Per `bench/README.md`, swapping the hashing embedder for a real MiniLM encoder
does **not** rescue it (50.0% vs 51.1% `R@10`), so this is a strategy problem, not an
embedding-quality problem.

## Per-family `recall@10`

| system | single-hop (12) | multi-session (8) | temporal (10) | knowledge-update (8) | preference (6) |
|---|---|---|---|---|---|
| random | 0.0% | 6.3% | 0.0% | 0.0% | 0.0% |
| bm25 | 100.0% | 68.8% | 90.0% | 100.0% | 100.0% |
| in-memory | 100.0% | 68.8% | 80.0% | 100.0% | 100.0% |
| file | 100.0% | 68.8% | 80.0% | 100.0% | 100.0% |
| enhanced | 66.7% | 37.5% | 40.0% | 0.0% | 33.3% |
| dual-layer | 100.0% | 81.3% | 70.0% | 62.5% | 66.7% |
| naive-rag | 100.0% | 18.8% | 40.0% | 50.0% | 16.7% |
| supermemory | 100.0% | 81.3% | 70.0% | 100.0% | 100.0% |

`single-hop` is saturated for every real system, so it no longer discriminates.
`multi-session` is the hardest answerable family for the in-process providers — 68.8% for
in-memory/file, and `dual-layer`'s 81.3% is its one clear win, matching supermemory.

## Knowledge-update: every system fails

`staleRate` = fraction of the 8 knowledge-update items where a superseded memory outranked the
current one. **Lower is better.**

| system | knowledge-update R@10 | staleRate |
|---|---|---|
| bm25 | 100.0% | 100% |
| dual-layer | 62.5% | 100% |
| supermemory | 100.0% | 100% |
| in-memory | 100.0% | 62.5% |
| file | 100.0% | 62.5% |
| naive-rag | 50.0% | 62.5% |
| enhanced | **0.0%** | 12.5% |
| random | 0.0% | 0% |

Read this carefully. `enhanced`'s 12.5% and `random`'s 0% are **not wins**: neither retrieves
the correct memory at all (`R@10` 0.0%), so there is nothing for a stale record to outrank. A
system that returns nothing useful trivially has no staleness. Do not present a low
`staleRate` without the paired `R@10`.

The honest summary: **no system in this comparison handles knowledge updates**, including
supermemory. This is the open problem, and it is a write-path problem — `findDuplicate`
compares normalized text for exact equality, so a revised fact is stored alongside the stale
one with both `active` and both permanently retrievable. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) Problem 2.

## Abstention (score calibration)

6 unanswerable queries whose named entity **is** richly present in the corpus, asking for an
attribute never stated anywhere. This measures **calibration, not refusal**: returning an
entity's memories for an unanswerable question is reasonable retrieval behaviour; being *as
confident* on an unanswerable query as on an answerable one is not.

Score scales are not comparable across systems, so a shared absolute threshold would be
meaningless. `tau` is per-system and per-run: the score that retains ~90% of that system's
*answerable* top-1 hits. `FPR@tau` is the fraction of the 6 no-answer queries still returning
a hit at or above `tau`. The paired retention number is printed beside it so a
suppress-everything system cannot look good.

| system | keep@tau (answerable retained) | FPR@tau (lower is better) |
|---|---|---|
| bm25 | 90.9% | **0.0%** |
| dual-layer | 90.9% | **0.0%** |
| supermemory | 84.1% | **0.0%** |
| naive-rag | 90.9% | 16.7% |
| in-memory | 90.9% | 50.0% |
| file | 90.9% | 50.0% |
| enhanced | 90.9% | 83.3% |
| random (control) | 100.0% | 100.0% |

n = 6 unanswerable, so a single item moves this by 16.7 points. Treat it as directional.
`in-memory`'s 50% is a genuine weakness: its max-normalized BM25 score means the top hit is
always ~1.0 regardless of how weak the absolute match was, which destroys the score's meaning
as a confidence signal. `enhanced` at 83.3% is barely distinguishable from the random control.

The runner also prints a second pair, `FPR@gate` with `R@10 @gate`, using per-system score
gates configured in the harness. Those gate constants have drifted from the providers' actual
`minScore` defaults in `src/` (in-memory is `0.05` in code, `0.2` in the harness; dual-layer
is `0.1` in code, `0.05` in the harness), so the `FPR@tau` column above is the one to quote
until they are reconciled.

## Latency

Reported separately from quality, on purpose.

**In-process** (same run, same corpus, search only):

| system | mean | p50 | p95 | ingest (527 records) |
|---|---|---|---|---|
| file | 0.07 ms | 0.06 ms | 0.16 ms | 10.9 ms |
| in-memory | 0.12 ms | 0.08 ms | 0.48 ms | 6.1 ms |
| naive-rag | 0.14 ms | 0.12 ms | 0.13 ms | 5.3 ms |
| bm25 | 0.34 ms | 0.14 ms | 0.37 ms | 2.8 ms |
| enhanced | 4.16 ms | 3.95 ms | 5.16 ms | 152.6 ms |
| dual-layer | 7.95 ms | 7.86 ms | 9.66 ms | 86.9 ms |

**Network-bound, reported separately and never compared to the above:** `supermemory` searches
at 1801.9 ms mean / 1564.9 ms p50 / 3355.2 ms p95, and ingests 527 records in 34.8 s
(15.2 records/s). That is round-trip time to a hosted service, not retrieval work.

`enhanced` is ~34x `in-memory` on search and ~25x on ingest while scoring 51 points worse on
`R@10`. `dual-layer` is the slowest in-process system.

## Reproducibility notes

- All rank-based metrics (`recall@k`, `allGold@k`, `nDCG@10`, `foundRate`, `staleRate`) are
  bit-identical across repeated runs and across a simulated 12-hour clock shift, for every
  system.
- Absolute *scores* drift slightly: `src/utils.ts recencyScore()` reads `Date.now()` at score
  time, which the harness cannot control. The abstention `tau` moves around the 8th decimal,
  and `enhanced` — whose score mixes recency with temporal boosts — shows ~0.1% relative
  movement in `MRR`/`meanRank` from near-ties flipping. Pass an explicit `--time-anchor` for a
  pinned run.
- The run JSON records the exact command, argv, dataset name/version/hash/seed/size, git SHA,
  dirty flag, node version, platform, retrieval depth, embedder and time anchor, so any number
  traces back to the run that produced it.

## What this harness does not cover yet

- **The `postgres` provider is not registered as a bench system.** It is the only durable
  backend and it has no measured retrieval number.
- **No answer-level evaluation.** This measures `MemoryProvider.search()` only. Nothing here
  says whether a downstream model answers correctly from the retrieved context.
- **No `buildContext` evaluation.** The endpoint agents actually call — profile prepending,
  greedy budget selection, character-based budgeting — is unmeasured.
- **No external suite.** Everything here is one synthetic corpus we wrote. Until a published
  benchmark is run, no claim about absolute quality is supportable.
- **`npm run bench:typecheck` currently fails** (exit 2, 157 errors), all in `src/**`:
  `bench/tsconfig.json` enables `noUncheckedIndexedAccess` and includes `../src/**/*.ts`,
  which the root `tsconfig.json` does not. `npm run typecheck` passes. The bench harness
  itself is clean; the errors are pre-existing `src` code that the stricter flag surfaces.

## Rules for quoting any of this

1. Name the dataset (`memory-core-internal-retrieval`, synthetic, authored here) and state
   that it is not LongMemEval or LoCoMo.
2. Give the command that reproduces the number.
3. Keep every compared row from the same run. Never place a third party's published score in
   a table beside these — external numbers belong in prose, attributed.
4. Pair `staleRate` with `R@10`, and `FPR@tau` with `keep@tau`. Neither means anything alone.
5. Keep network-bound latency out of in-process latency tables.
