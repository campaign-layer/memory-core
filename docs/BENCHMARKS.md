# Benchmarks

Every retrieval number this project publishes, with the command that produces it and the
caveats that limit it.

## Read this first

**All numbers on this page come from our own harness.** That is true of the synthetic suite
and equally true of the two public datasets. It means:

- **These are not leaderboard scores.** LongMemEval and LoCoMo are public datasets, but the
  retrieval granularity, the reader model, and the judge model used here are ours. Published
  figures from those papers, or from any vendor's write-up, were measured differently.
  **Do not compare a number on this page to a published one.**
- **Comparisons are valid only within a table.** Every row in a table went through the same
  harness, over the same corpus, with the same metric definitions and the same denominator.
  Where a row came from a separate invocation, it is marked.
- **Third-party systems were run by us**, not quoted. `supermemory` was driven through the
  `bench/` harness over the same fixture; `mem0 OSS 2.0.14` was driven through the LoCoMo
  harness over the same conversations. Neither number is borrowed.

### At-a-glance comparison with other memory systems

These are the only defensible cross-system scores currently available because the compared
systems were executed by us through the same harness. Rows from different datasets are not
comparable with each other.

| Dataset and metric | Memory Core | Compared system | Honest result |
|---|---:|---:|---|
| Synthetic R@1 | hybrid **.489** | supermemory .409 | Memory Core wins on our self-authored dataset; weakest evidence. |
| Synthetic R@5 | hybrid **.830** | supermemory .807 | Memory Core hybrid wins; Memory Core BM25-only loses at .625. |
| Synthetic R@10 | hybrid **.955** | supermemory .898 | Memory Core hybrid wins retrieval depth. |
| LoCoMo R@1 | hybrid .344 | mem0 OSS 2.0.14 **.345** | Effectively tied; mem0 is higher. |
| LoCoMo R@5 | hybrid .620 | mem0 **.635** | mem0 wins early precision. |
| LoCoMo R@10 | hybrid **.709** | mem0 .694 | Memory Core wins retrieval depth. |
| LoCoMo R@30 | hybrid **.817** | mem0 .783 | Memory Core wins retrieval depth. |
| LoCoMo QA accuracy, matched n=233 | hybrid .451 | mem0 **.476** | mem0 wins downstream QA in this reader setup. |

Memory Core has **not** been run through this harness against Zep/Graphiti, Letta, LangMem or
other memory projects, and supermemory has not been run through the public-dataset harnesses.
Those systems therefore have no score here. “Not measured” is not a loss or a win.

This table measures retrieval and one constrained QA reader. It does not establish that a
Claude, Codex, OpenAI Agents, Hermes or other autonomous agent completes more work with
Memory Core enabled. The paired memory-on/off and longitudinal design for that question is
[`AGENT_EVALUATION.md`](./AGENT_EVALUATION.md).

### What you can reproduce, and what you cannot

| suite | harness | reproducible from this checkout? |
|---|---|---|
| synthetic (`memory-core-internal-retrieval`) | [`bench/`](../bench/README.md), committed | **Yes.** Fixtures are committed and regenerate byte-identically. |
| LongMemEval_S | [`bench/longmemeval/`](../bench/longmemeval/), committed | **Yes, after downloading the dataset** (278 MB, see its `DATA.md`). Mode B also needs an API key. |
| LoCoMo (incl. mem0 head-to-head) | [`bench/locomo/`](../bench/locomo/), committed | **Yes, after downloading the dataset** and creating the Python environment in `requirements.txt`. The mem0 run costs roughly $3.50. |

Every result artifact behind sections 2 and 3 is committed next to its harness, so any number
here can be traced to a JSON file carrying the git SHA, dataset checksum, model id and command
line that produced it. The datasets themselves are third-party and are not vendored.

## The retracted claim

A previous version of the README advertised **"27.9% accuracy on LongMemEval"** for the
`enhanced` provider. **That number was manufactured by the code that produced it.**
`extractIntelligentAnswer()` returned the literal string
`"GPS system not functioning correctly"` — verbatim the gold answer to LongMemEval
question 1 — and entity gazetteers hardcoded further answer keys (`Rachel|John|Mary`,
`Yellowstone|Hawaii`, `Effective Communication|Data Analysis`, `tomatoes|marigolds|seeds`).
It measured answer injection, not retrieval.

All of that code is deleted. `bench/dataset/spec.ts` asserts that the generated corpus
contains none of those tokens, so the same class of cheat cannot silently return. The number
is retracted and is not replaced by another figure for that provider. `enhanced`'s real
measured LongMemEval R@10 is **.1254**, against a **.0139** random floor.

---

## 1. Synthetic suite — `memory-core-internal-retrieval`

**Our dataset. The weakest evidence on this page.** A corpus generated from sentence
templates inside this repository. We wrote it, so it can unintentionally favour our own
systems. It measures one thing: whether a retriever ranks the right memory above
vocabulary-sharing distractors. It says nothing about natural-language variety, real user
phrasing, long documents, or answer quality. Treat any cross-system gap here as a hypothesis
to confirm elsewhere.

**It is not LongMemEval, not LoCoMo, and not any published suite.**

### Reproducing

```bash
# hybrid: downloads a ~35 MB ONNX model on first run, then offline
MEMORY_EMBEDDER=local MEMORY_RRF_K=5 \
  npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# BM25-only: MEMORY_EMBEDDER unset defaults to "none"
npx tsx bench/run.ts --systems=random,bm25,in-memory --size=small --k=10

# live third-party comparison
SUPERMEMORY_API_KEY=... npx tsx bench/run.ts --systems=supermemory --size=small --k=10

# the deprecated providers, for the record
npx tsx bench/run.ts --systems=random,enhanced,dual-layer,naive-rag --size=small --k=10
```

`bench/run.ts` generates the fixture if it is missing, so a bare run works from a clean
checkout. `random` is always run whether or not you ask for it.

### Provenance

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
| git | `4120bc0` (hybrid and BM25-only runs); `7f90586` (supermemory run) |
| node / platform | v22.14.0 / darwin |

Every system goes through the same `ingest → search` path, searched with `minScore: 0` so
rank metrics measure ranking rather than an arbitrary cutoff.

**On splicing runs.** The `supermemory` row comes from a separate invocation of the same
harness against the same fixture hash. The `random` control is re-run in every invocation and
matched bit-for-bit across all of them — R@10 1.1%, MRR 0.0171, meanRank 407.2, per-family
MRR identical to three decimals — which is the evidence that the runs sit on one footing.
This is weaker than a single run and is stated rather than hidden.

### Metrics

Defined in `bench/metrics.ts`. Design rule: no metric here can be maximised by returning
everything, and none can look good on a ranking that carries no information.

- **`recall@k`** (k = 1, 5, 10) — fraction of an item's gold memories inside the top k,
  averaged per item (partial credit).
- **`allGold@k`** — fraction of items where *every* gold memory is inside the top k. The
  honest number for `multi-session`, where partial-credit `recall@1` caps at 0.5 by
  construction.
- **`MRR`, `nDCG@10`** — binary gains; ideal DCG packs all gold at the top.
- **`meanRank`** — best gold rank. Gold that is never retrieved is charged `corpusSize + 1`,
  so a complete miss cannot hide behind a good average.
- **`foundRate`** — fraction of items where gold appeared anywhere in the returned ranking.
- **`staleRate`** (knowledge-update only) — fraction of items where a superseded memory
  outranked the current one. Both records are ingested `active`; detecting the update is the
  system's job.
- **Latency** — reported in a separate table from quality, with network-bound systems flagged
  and never mixed with in-process numbers.

### Overall

| system | R@1 | R@5 | R@10 | allGold@10 | MRR | nDCG@10 | meanRank | foundRate |
|---|---|---|---|---|---|---|---|---|
| random (control) | 0.0% | 1.1% | 1.1% | 0.0% | 0.017 | 0.009 | 407.2 | 25.0% |
| `bm25` (Okapi, lexical only) | 34.1% | 67.0% | 92.0% | 86.4% | 0.587 | 0.633 | 3.3 | 100.0% |
| memory-core BM25-only | 40.9% | 62.5% | 89.8% | 84.1% | 0.615 | 0.648 | 3.6 | 100.0% |
| supermemory (live API) | 40.9% | 80.7% | 89.8% | 86.4% | 0.662 | 0.688 | 38.0 | 93.2% |
| **memory-core hybrid** (`local`, `rrfK=5`) | **48.9%** | **83.0%** | **95.5%** | **90.9%** | **0.688** | **0.721** | **2.6** | 100.0% |

Deprecated providers, from the same corpus:

| system | R@1 | R@5 | R@10 | MRR | nDCG@10 | meanRank | foundRate |
|---|---|---|---|---|---|---|---|
| `dual-layer` | 39.8% | 70.5% | 78.4% | 0.605 | 0.616 | 4.2 | 100.0% |
| `naive-rag` (plain-RAG control) | 0.0% | 33.0% | 51.1% | 0.149 | 0.214 | 17.7 | 100.0% |
| `enhanced` | 13.6% | 31.8% | 38.6% | 0.250 | 0.258 | 222.4 | 59.1% |

Analytic random baseline for this corpus (527 memories, depth 100): `E[R@1] = 0.19%`,
`E[R@5] = 0.95%`, `E[R@10] = 1.9%`, `E[meanRank] = 423.9`, `E[MRR] = 0.0115`.

`file` is omitted because `FileProvider` inherits the in-memory scoring exactly; its rows
match `in-memory` in every column.

### Findings, including the losses

**1. Hybrid retrieval is the whole improvement.** Turning the embedder on moves R@5 from
62.5% to 83.0% and R@10 from 89.8% to 95.5% on the same corpus, same code, same run
configuration. Nothing else in this repository has produced a comparable move.

**2. Without an embedder, plain Okapi BM25 beats our own provider on R@10** — 92.0% vs
89.8%. Our recency, confidence and importance priors cost recall depth to buy 6.8 points of
R@1. That trade only becomes clearly favourable once the vector side is on.

**3. Without an embedder, supermemory beats us in the middle of the ranking.** Same R@1
(40.9%) and same R@10 (89.8%), but R@5 80.7% vs 62.5%, MRR 0.662 vs 0.615, nDCG@10 0.688 vs
0.648. For an agent splicing the top 5 into a prompt, that is the gap that matters, and it
was theirs. Hybrid closes it on this corpus.

**4. supermemory's `foundRate` is 93.2% against our 100%**, and its `meanRank` is 38.0
against our 2.6 — its losses are concentrated in complete misses rather than bad ordering,
which is the opposite failure shape to ours.

**5. Calibration got worse when quality got better.** See
[Abstention](#abstention-score-calibration): hybrid's `FPR@tau` is 66.7%, worse than
BM25-only's 50.0% and far worse than supermemory's 0.0%. Better ranking did not buy a better
confidence signal.

### Per-family `recall@10`

| system | single-hop (12) | multi-session (8) | temporal (10) | knowledge-update (8) | preference (6) |
|---|---|---|---|---|---|
| random | 0.0% | 6.3% | 0.0% | 0.0% | 0.0% |
| `bm25` | 100.0% | 68.8% | 90.0% | 100.0% | 100.0% |
| memory-core BM25-only | 100.0% | 68.8% | 80.0% | 100.0% | 100.0% |
| supermemory | 100.0% | **81.3%** | 70.0% | 100.0% | 100.0% |
| memory-core hybrid | 100.0% | 75.0% | **100.0%** | 100.0% | 100.0% |

`recall@10` saturates for every real system, so per-family **MRR** is the discriminating
view — it shows where gold actually lands:

| system | single-hop | multi-session | temporal | knowledge-update | preference |
|---|---|---|---|---|---|
| random | 0.000 | 0.073 | 0.006 | 0.010 | 0.004 |
| `bm25` | 1.000 | 0.875 | 0.324 | 0.351 | 0.129 |
| memory-core BM25-only | 1.000 | 0.875 | 0.362 | 0.462 | 0.127 |
| supermemory | 1.000 | **1.000** | 0.433 | 0.383 | **0.290** |
| memory-core hybrid | 1.000 | 0.938 | **0.505** | **0.542** | 0.231 |

**supermemory still wins `multi-session` (MRR 1.000 vs 0.938) and `preference`
(0.290 vs 0.231) against our hybrid configuration.** `preference` is the weakest family for
every system on this corpus, and the one where lexical overlap helps least.

### Knowledge-update: nothing handles it

`staleRate` = fraction of the 8 knowledge-update items where a superseded memory outranked
the current one. **Lower is better, and it means nothing without the paired `R@10`.**

| system | knowledge-update R@10 | staleRate |
|---|---|---|
| `bm25` | 100.0% | 100% |
| supermemory | 100.0% | 100% |
| memory-core BM25-only | 100.0% | 62.5% |
| memory-core hybrid | 100.0% | 62.5% |
| `dual-layer` | 62.5% | 100% |
| `naive-rag` | 50.0% | 62.5% |
| `enhanced` | **0.0%** | 12.5% |
| random | 0.0% | 0% |

`enhanced`'s 12.5% and `random`'s 0% are **not wins**: neither retrieves the correct memory
at all, so there is nothing for a stale record to outrank. A system that returns nothing
useful trivially has no staleness.

The honest summary: **no system here handles knowledge updates**, including supermemory. It
is a write-path problem — `findDuplicate` compares normalized text for exact equality, so a
revised fact is stored alongside the stale one with both `active`. See
[`ARCHITECTURE.md`](./ARCHITECTURE.md) Problem 2.

### Abstention (score calibration)

6 unanswerable queries whose named entity **is** richly present in the corpus, asking for an
attribute never stated anywhere. This measures **calibration, not refusal**: returning an
entity's memories for an unanswerable question is reasonable; being *as confident* on an
unanswerable query as on an answerable one is not.

Score scales are not comparable across systems, so a shared absolute threshold would be
meaningless. `tau` is per-system and per-run: the score that retains ~90% of that system's
*answerable* top-1 hits. `FPR@tau` is the fraction of the 6 no-answer queries still returning
a hit at or above `tau`. Retention is printed beside it so a suppress-everything system
cannot look good.

| system | keep@tau (answerable retained) | FPR@tau (lower is better) |
|---|---|---|
| `bm25` | 90.9% | **0.0%** |
| supermemory | 84.1% | **0.0%** |
| memory-core BM25-only | 90.9% | 50.0% |
| memory-core hybrid | 90.9% | 66.7% |
| random (control) | 100.0% | 100.0% |

n = 6, so one item moves this by 16.7 points; treat it as directional. **The direction is
against us.** Both memory-core configurations max-normalize their relevance score, so the top
hit always scores near 1.0 no matter how weak the absolute match — which satisfies the 0–1
score contract and destroys the score's meaning as a confidence signal. Hybrid makes it worse
because RRF has no notion of magnitude at all: an item found only by vector search at rank 1
scores `1/(k+1)`, identical to a mediocre lexical match at rank 1.

The runner also prints `FPR@gate` paired with `R@10 @gate`, using the providers' own
`minScore` defaults. Those gate constants have drifted from the values in `src/`, so the
`FPR@tau` column above is the one to quote until they are reconciled.

### Latency

Reported separately from quality, on purpose. Same runs as the tables above, on one machine
(darwin, Node v22.14.0).

**In-process**, search only:

| system | mean | p50 | p95 | ingest (527 records) |
|---|---|---|---|---|
| random | 0.05 ms | 0.03 ms | 0.14 ms | 0.02 ms |
| memory-core BM25-only | 0.11 ms | 0.07 ms | 0.20 ms | 6.1 ms |
| `bm25` | 0.33 ms | 0.13 ms | 0.35 ms | 2.5 ms |
| **memory-core hybrid** | **6.17 ms** | — | **8.65 ms** | **3,670 ms** |

Hybrid costs roughly **58x the search latency and 600x the ingest time** of BM25-only on this
machine, for the quality gain in the table above. Local ONNX inference on CPU is the whole
cost; a GPU or a batched remote embedder changes the shape entirely.

**Network-bound, never compared to the above:** `supermemory` searches at 1801.9 ms mean /
1564.9 ms p50 / 3355.2 ms p95 and ingests 527 records in 34.8 s (15.2 records/s). That is
round-trip time to a hosted service, not retrieval work.

### Reproducibility notes

- All rank-based metrics are bit-identical across repeated runs and across a simulated
  12-hour clock shift, for every system.
- Absolute *scores* drift slightly: `src/utils.ts recencyScore()` reads `Date.now()` at score
  time, which the harness cannot control. Pass an explicit `--time-anchor` for a pinned run.
- The run JSON records the exact command, argv, dataset name/version/hash/seed/size, git SHA,
  dirty flag, node version, platform, retrieval depth, embedder and time anchor, so any
  number traces back to the run that produced it.
- `npm run bench:dataset` regenerates `bench/dataset/generated/small-seed1337.json`
  byte-identically; CI asserts this.

---

## 2. LongMemEval_S — public dataset, our harness

500 questions, **479 scored**; the 21 abstention questions are scored separately.

> **Our harness, not the leaderboard.** Retrieval granularity, reader and judge are ours.
> These numbers are not comparable to published LongMemEval results. The harness is in
> `bench/longmemeval/` and the result artifacts are committed; reproducing requires
> downloading the dataset (see its `DATA.md`).

| system | R@1 | R@10 | R@30 | MRR | meanRank |
|---|---|---|---|---|---|
| memory-core | .3429 | **.8023** | **.8892** | **.6479** | **20.8** |
| bm25 baseline | **.3619** | .7797 | .8679 | .6459 | 28.8 |
| mc-dual-layer | .0494 | .4764 | .6649 | .2339 | 52.7 |
| mc-enhanced | .0565 | .1254 | .1936 | .1355 | 274.3 |
| random control | .0017 | .0139 | .0576 | .0180 | 351.9 |

**A lexical BM25 baseline beats us on R@1** (.3619 vs .3429). We win recall depth: R@10,
R@30, and mean rank 20.8 against 28.8. That is the same shape the synthetic suite shows —
hybrid retrieval buys depth, not top-1 precision.

`mc-enhanced` at R@10 .1254 sits against a .0139 random floor and was flagged
**at or below random on mean rank** by the harness. See
[Deprecated providers](#deprecated-providers).

### rrfK, on a subset

Hybrid retrieval was evaluated on a **150-question stratified subset (n = 142 scored)**, not
the full 500. On that subset:

| | `rrfK=5` | `rrfK=60` |
|---|---|---|
| R@10 | **.8716** | .8648 |
| R@1 | .3460 | **.3527** |

Paired tests on that subset are the strictest read available and they narrow the claim
considerably: recall@1 −0.007 (not significant — exactly **one** question ranked differently
at all), recall@5 +0.019 (ns), recall@10 +0.007 (ns), and **recall@30 +0.031, t = 2.65,
significant, 9 wins / 0 losses.**

So the honest justification for the `rrfK=5` default is *"deeper recall improves and nothing
regresses"*, **not** *"recall@1 improves"*. The +13.7pt recall@1 gain measured on the
synthetic suite does not replicate here — it reverses sign — and must never be quoted as a
general property.

**The n = 142 subset and the n = 479 table above are different runs with different
denominators. Do not combine them.**

### Answer accuracy

Reader and judge are both `deepseek/deepseek-v4-flash`. Bracketed figures are 95% confidence
intervals.

| condition | accuracy |
|---|---|
| retrieval @ k=10 | 62.6% [58.2 – 66.8] |
| retrieval @ k=30 | 69.5% [65.3 – 73.5] |
| oracle (gold evidence supplied directly) | 82.0% [75.1 – 87.3] |

The oracle row is the ceiling this reader imposes: handed the correct evidence, the answering
step still gets 18% wrong. Retrieval improvements above roughly 82% are not measurable with
this reader, and a QA delta below the width of these intervals is not a result.

---

## 3. LoCoMo — public dataset, our harness, head-to-head with mem0

10 conversations, **n = 1,531 answerable questions**, against **mem0 OSS 2.0.14** which we
ran ourselves through the same harness over the same conversations.

> **Our harness, not the leaderboard.** Same caveat as above. The harness and result
> artifacts are committed; reproduction requires downloading the LoCoMo dataset and creating
> the pinned Python environment.

| system | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 |
|---|---|---|---|---|---|---|
| mem0 OSS 2.0.14 | **.345** | **.635** | .694 | .783 | **.534** | **.548** |
| memory-core hybrid (`rrfK=5`) | .344 | .620 | **.709** | **.817** | .524 | .544 |
| memory-core BM25-only | .332 | .555 | .626 | .726 | .482 | .494 |
| bm25 baseline | .303 | .507 | .578 | .673 | .437 | .450 |
| random control | .002 | .012 | .020 | .057 | .012 | .010 |

**mem0 wins R@1, R@5, MRR and nDCG@10.** We win R@10 and R@30. The pattern is consistent
across every dataset on this page: mem0 (and supermemory, and plain BM25 on LongMemEval) put
the right item at the very top more often; we put it somewhere in the top 10–30 more often.

### Answer accuracy

Matched denominators, n = 233:

| condition | accuracy |
|---|---|
| oracle (gold evidence supplied directly) | .485 |
| **mem0 @ k=30** | **.476** |
| memory-core hybrid @ k=30 | .451 |

**mem0 beats us on QA accuracy.** But note the oracle: .485 with gold evidence handed over
directly. The reader dominates and every retrieval system compresses under a low ceiling, so
**rank metrics are the signal on this dataset, not QA accuracy** — mem0's .476 is already
98% of the achievable maximum.

### Ingest cost

Same 5,882 conversation turns:

| system | wall clock | LLM calls | prompt tokens | cost | search latency |
|---|---|---|---|---|---|
| memory-core BM25-only | 0.07 s | 0 | 0 | $0 | 0.167 ms |
| memory-core hybrid | 104 s | 0 | 0 | $0 | 15.8 ms |
| mem0 | 28,827 s | 5,882 | 51.6 M | $3.45 | 37.9 ms |

mem0's quality advantage is bought with an LLM call per turn. Across those 5,882 turns mem0
emitted 3,164 memory events and **every one was `ADD` — zero `UPDATE`, zero `DELETE`.** Its
edge comes from *extraction and distillation* on the write path, not from a merge/supersede
loop. That observation is what sets the priority order in
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Deprecated providers

`enhanced` and `dual-layer` are **not recommended for any use.** They remain in the tree
because deleting them would erase the evidence.

| provider | LongMemEval R@10 | LongMemEval meanRank | synthetic R@10 |
|---|---|---|---|
| random floor | .0139 | 351.9 | 1.1% |
| `enhanced` | **.1254** | **274.3** | 38.6% |
| `dual-layer` | .4764 | 52.7 | 78.4% |
| memory-core | .8023 | 20.8 | 95.5% |

`enhanced` scores below one seventh of the working provider on LongMemEval R@10, and the
harness flagged it **at or below random on mean rank**. Its "384-dimensional embedding
vectors" were a `MockEmbeddingService` that built a vector by adding `sin(hash(token) + j)`
into every dimension for every token — cosine over those vectors is a function of token
hashes, not of meaning. An earlier README called it "Production Ready" and claimed "95%+
accuracy". Both were false.

## Engine performance, before and after the rework

Not retrieval quality — raw operation cost. Same machine, 50,000 records, measured before and
after the O(N)-read-path rework described in
[`ARCHITECTURE.md`](./ARCHITECTURE.md#status-update).

| operation | before | after |
|---|---|---|
| `getById` × 2000 | 17,395 ms | **1.0 ms** |
| `findDuplicate` × 2000 | 30,121 ms | **3.0 ms** |
| batch ingest, 8,000 records | 8,084 ms | **83 ms** |

The cause was `pruneExpired()` running a full store scan at the top of every read, plus an
O(N) dedupe scan per observation. Decay is now evaluated lazily on read and dedupe goes
through a normalized-text index.

## What this page does not cover

- **The `postgres` provider has no measured retrieval number.** It is not registered in
  `bench/systems/index.ts`, and it is the only durable backend. The fault canary used its
  lexical path for compatibility and persistence, not a labeled quality corpus.
- **`buildContext` has only an internal regression**, not a public end-to-end agent score.
  On the repository-authored small fixture it retained 76.92% of labeled evidence, produced
  72.73% all-gold contexts and zero character-budget violations, but stale evidence outranked
  current evidence in 37.5% of update cases and every abstention case leaked some evidence.
  These are regression signals, not proof that an agent's answer or task outcome improves.
- **The LLM extractor (`MEMORY_EXTRACTOR=llm`) is unmeasured.** Every number on this page was
  produced with extraction off, which is the default.
- **No multilingual or long-document evaluation** anywhere.
- **No paired autonomous-agent outcome experiment.** Framework execution, retrieval ranking
  and service uptime are measured separately; none is a causal memory-on/off task-success
  result.

## Rules for quoting any of this

1. Name the dataset, and say whether it is ours (`memory-core-internal-retrieval`, synthetic,
   authored here) or public-but-our-harness (LongMemEval, LoCoMo).
2. Give the command that reproduces it, or say plainly that the harness is not published.
3. Never place a third party's *published* score in a table beside these. External numbers
   belong in prose, attributed. Systems we ran ourselves are fine in the table.
4. Keep every compared row from the same run, or mark the splice and show that the shared
   `random` control matched.
5. Pair `staleRate` with `R@10`, `FPR@tau` with `keep@tau`, and quality with cost.
6. Keep network-bound latency out of in-process latency tables.
7. Quote the losses with the wins. There are more of the former on this page than the latter.
