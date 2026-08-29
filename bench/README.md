# memory-core benchmarks

Three suites live here, in ascending order of evidential weight. All three are runnable
from a clean checkout; two of them need a third-party dataset downloaded first.

| suite | dataset | who wrote the dataset | where |
|---|---|---|---|
| **synthetic** | `memory-core-internal-retrieval` v1.0.0 | **us** | this directory |
| **LongMemEval_S** | 500 questions, public | [Wu et al. 2024](https://arxiv.org/abs/2410.10813) | [`longmemeval/`](longmemeval/) |
| **LoCoMo** | 10 conversations, 1,986 questions, public | [Maharana et al. 2024](https://arxiv.org/abs/2402.17753) | [`locomo/`](locomo/) |

## The three rules that apply to all of them

**1. The synthetic suite is ours, and it proves the least.** We wrote the corpus, so it
can flatter our own systems. It is first in this file because it is the oldest, not
because it is the strongest evidence. Treat any cross-system gap it shows as a
hypothesis, not a result.

**2. LongMemEval and LoCoMo are public *datasets* run through *our* harness. The numbers
are not comparable to published leaderboard figures.** The datasets are the authors'; the
retrieval granularity (one memory per conversation turn), the corpus construction, the
reader model, the judge model and every prompt are ours. A number from the LongMemEval or
LoCoMo paper, from a leaderboard, or from any vendor's blog post was measured differently
and **must never be placed in a table next to ours.** Cite it in prose, attributed, or not
at all. The only valid comparisons are *within* one of our reports, because every row in
one report went through the same harness over the same corpus with the same metric
definitions.

The one third-party system we do compare against directly — **mem0 OSS 2.0.14** on
LoCoMo — was run **by us, through this harness**, not quoted from mem0's materials. That
is what makes it a legitimate row rather than a borrowed number.

**3. Every published number traces to a committed artifact.** See
[Which artifact backs which table](#which-artifact-backs-which-table) below.

---

## 1. Synthetic suite — our dataset, weakest evidence

*Everything from here to [section 2](#2-longmemeval_s--public-dataset-our-harness) documents this suite only.*

The dataset is **synthetic and authored inside this repository**. Its internal name is
`memory-core-internal-retrieval` (MCIR).

- **It is NOT LongMemEval.** It is not LoCoMo, not MemGPT's suite, not any published
  benchmark. Numbers produced here are **not comparable** to published scores on those
  suites, and must never be presented as if they were. Our runs over the real
  LongMemEval and LoCoMo datasets live in [`longmemeval/`](longmemeval/) and
  [`locomo/`](locomo/) — separate harnesses, separate data, separate numbers.
- If you cite a number from here, label it as an internal synthetic suite and state the
  provenance line the runner prints: dataset name + version + hash + seed + size + git SHA.
- The corpus is generated from sentence templates. It measures whether a retriever can
  rank the right memory above vocabulary-sharing distractors. It does **not** measure
  natural-language variety, real user phrasing, multilingual behaviour, long-document
  handling, or end-to-end answer quality.
- Every comparison the runner prints comes from **one harness, one corpus, one metric
  definition**, because every system goes through the same `ingest -> search` path. Do not
  paste a third party's published score into a table next to these rows.

### What it does prove

Given the same corpus and the same query set, whether system A ranks the correct memory
higher than system B, and whether either is distinguishable from a random ordering or from
plain lexical matching.

### What it does not prove

That any system is "good". A high score here is necessary but nowhere near sufficient.

### Quick start

```bash
# generate the fixtures (deterministic; committed so runs are diffable)
npx tsx bench/dataset/generate.ts --size=small --seed=1337
npx tsx bench/dataset/generate.ts --size=large --seed=1337

# run the default system set (~2s small, ~25s large)
npx tsx bench/run.ts --size=small
npx tsx bench/run.ts --size=large --json=bench/out/large.json

# pick systems explicitly
npx tsx bench/run.ts --systems=in-memory,enhanced,bm25,random,naive-rag --size=small --k=10
```

`bench/run.ts` generates the fixture automatically if it is missing, so a bare
`npx tsx bench/run.ts` works from a clean checkout.

The agent-facing context surface has a separate internal regression command:

```bash
npm run bench:context
npx tsx bench/context.ts --size=large --max-items=8 --max-chars=3000 \
  --time-anchor=2026-08-28T00:00:00.000Z --json=bench/out/context-large.json

# credentialed semantic precision/abstention run; fails rather than silently falling back
VOYAGE_API_KEY=... npx tsx bench/context.ts --reranker=voyage \
  --reranker-model=rerank-2.5 --reranker-min-score=0.2
```

It runs `MemoryCoreService.buildContext` and reports gold evidence retained, all-gold rate,
gold-at-one/MRR, stale and hard-negative inclusion, whether either outranked the current/gold
evidence, abstention leakage, near-duplicate selection, exact character-budget violations,
utilization, and latency. Inclusion and ordering are deliberately separate: a distractor
appearing at the bottom of an eight-item evidence block is not the same failure as it beating
the answer. It uses the same repository-authored synthetic corpus, so it is a regression
gate—not an end-to-end answer-quality or public SOTA score.

CI passes `--assert-baseline`, which applies deliberately loose floors/ceilings around the
deterministic 2026-08-29 internal result. It catches accidental code regressions; it is not a
public quality threshold and does not waive the held-out evaluation gate.

`--reranker=voyage` reranks at most 50 BM25 candidates per query through the same service
path production agents use. It requires `VOYAGE_API_KEY`; a missing key is a hard benchmark
error so a baseline fallback can never be mislabeled as a reranker result. Tune
`--reranker-min-score=0..1` on a development split and report retention beside abstention—do
not choose it on the test queries.

#### Flags

| flag | default | meaning |
| --- | --- | --- |
| `--systems=a,b,c` | `in-memory,file,enhanced,bm25,random,naive-rag` | systems to run. `random` is appended if omitted. |
| `--size=small\|large` | `small` | 50 items / 527 memories, or 500 items / 5267 memories |
| `--seed=N` | `1337` | dataset seed |
| `--k=N` | `10` | top-k reported in the headline table |
| `--json=path` | `bench/out/<runId>/results.json` | machine-readable output |
| `--embedder=hash\|bench-hash\|minilm` | `hash` | embedding backend for `naive-rag` |
| `--time-anchor=<iso>` | UTC midnight of the run day | corpus timestamps are placed relative to this |

### The six task families

These are the things that distinguish a memory system from a plain vector store. Every
item carries a `distractorNote` in the fixture explaining its specific trap.

| family | what it tests | the trap |
| --- | --- | --- |
| `single-hop` | one memory answers directly | a near-identical sentence about a different entity, plus the same entity with the wrong attribute |
| `multi-session` | join facts stated in two different sessions | a single distractor memory contains every query token and gives a wrong one-hop answer |
| `temporal` | "first" / "most recent" / "before X" ordering | the **stale** memory is deliberately the better lexical match and/or the more recent one |
| `knowledge-update` | a fact was later revised | the superseded memory is short and a verbatim phrase match; the current one is longer and still mentions the old value |
| `abstention` | the answer is genuinely absent | the query names an entity that **is** richly present in the corpus, asking for an attribute that is never stated anywhere |
| `preference` | durable preferences that are not lexically similar to the query | the gold preference shares only one token with the query; distractors share two or three |

Additional difficulty applied to every answerable item: **4 anchor-noise memories** that
mention the item's entity but answer nothing. Without them, a bare entity-token match
would put gold at rank 1 for free and every scorer would look excellent.

#### Label integrity

`validateDataset()` runs on every generate and every load, and **throws** rather than
emitting a subtly broken corpus. It enforces:

- every gold / superseded id exists in the corpus
- abstention items have no gold; answerable items have gold
- **no two items share a query**, and every answerable item's query is keyed on a
  **globally unique anchor entity**. This one matters: three templates originally keyed
  their query on a repeatable slot, which at `--size=large` produced two items asking the
  same question with different gold labels. That silently penalises every system.
- anchors and distractor entities are drawn from **disjoint halves** of the same
  cross-product pool, so a distractor can never collide with another item's anchor
- abstention anchors really do appear in the corpus (otherwise the item is trivial)
- the corpus contains **none of the entity-gazetteer tokens hardcoded in
  `src/providers/enhanced-provider.ts`** (`Rachel|John|Mary|Mike|Sarah|David`,
  `Yellowstone|Hawaii|Virginia`, `tomatoes|marigolds|seeds`, `gps`, ...). Those gazetteers
  are keyed to another benchmark's answer set; letting them fire here would hand one
  system free points and make the comparison dishonest.

### Metrics

`bench/metrics.ts`. Design rule: **no metric here can be maximised by returning
everything**, and none can look good on a ranking that carries no information.

- `recall@k` (k = 1, 5, 10) — fraction of an item's gold memories inside top-k, averaged
  per item (partial credit).
- `allGold@k` — fraction of items where *every* gold memory is inside top-k. This is the
  honest number for `multi-session`; partial-credit recall@1 caps at 0.5 there by
  construction.
- `MRR`, `nDCG@10` — binary gains, ideal DCG = all gold packed at the top.
- `meanRank` / `medianRank` — best gold rank. Gold not retrieved is charged
  `corpusSize + 1`, so a system that simply fails to return gold cannot hide.
- `foundRate` — fraction of items where gold appeared anywhere in the returned ranking.
- `staleRate` (`knowledge-update`) — fraction where a superseded memory outranked the
  current one. Both records are ingested with `status: "active"` and **nothing is
  pre-marked superseded**: detecting the update is the system's job, not the harness's.
- Latency: mean / p50 / p95 per operation, plus throughput. Reported in a **separate
  table** from retrieval quality, and network-bound systems are flagged so their RTT
  never colours their quality numbers.

#### Abstention, and why there are two numbers

Score scales are not comparable across systems, so a single shared absolute threshold
would be meaningless. Both numbers use the identical recipe for every system:

1. **`FPR@tau`** — `tau` is the score that retains 90% of *answerable* queries **in this
   run for this system** (10th percentile of answerable top-1 scores). `FPR@tau` is the
   fraction of no-answer queries still returning a hit at or above `tau`. Scale-free.
   `keep@tau` is printed beside it so you can see the operating point really is ~90%.
2. **`FPR@gate` paired with `R@10 @gate`** — using the system's *own* documented default
   score gate (`0.2` for in-memory/file, `0.05` for enhanced, `0.6` for supermemory).
   These two are always printed together: a system that suppresses everything drives FPR
   to 0 and recall to 0 at the same time. Systems with no principled gate show `none`/`n/a`
   rather than a trivial 100%.

Note the framing: this measures **score calibration**, not refusal. Returning an entity's
memories for an unanswerable question is reasonable retrieval behaviour; being *as
confident* on unanswerable queries as on answerable ones is not.

#### The random baseline is always printed

Non-negotiable. The `random` system runs even if you leave it out of `--systems`, and the
runner also prints a closed-form `[analytic random]` row: `E[recall@k] = k/N`,
`E[best gold rank]` and `E[MRR]` for a uniform random ranking over the same corpus, with
the depth cap folded in.

Any system whose `recall@10` is not convincingly above the analytic baseline gets a loud
`!! AT/BELOW RANDOM` line. This exists because a prior audit found a provider scoring
mean rank 2.5 on a 4-item corpus — exactly chance — and nothing in the repo would have
revealed it.

### Systems

| name | what it is |
| --- | --- |
| `in-memory`, `file`, `enhanced`, `dual-layer` | the existing providers, via `src/providers/factory.ts`. These are the "before" numbers. |
| `bm25` | Okapi BM25 (k1=1.5, b=0.75), lexical only: no recency, importance, type priors or embeddings. |
| `random` | seeded-shuffle sanity floor. |
| `naive-rag` | plain-RAG control: chunk, embed, cosine top-k, nothing else. |
| `supermemory` | live HTTP API adapter. |

All systems are asked for the **top 100** (`RETRIEVAL_DEPTH`). The `src` providers hard-cap
`search` at 100 hits, so asking anyone for more would make the comparison unequal. Gold
outside the top 100 counts as not retrieved.

Provider-backed systems are searched with `minScore: 0` so ranking metrics measure ranking
rather than an arbitrary default cutoff; the cutoff is then re-applied client-side for the
`FPR@gate` operating point. One search call, both numbers.

#### `naive-rag` — important caveat about the embedder

It chunks **session transcripts** (400 chars, 100 overlap), not individual memories — that
is what a plain vector store over conversation logs actually does, and it reproduces the
real failure mode where one chunk carries a fact and its distractor at the same score.
Chunks are ranked by cosine and then expanded into member memories in transcript order.

Three backends are selectable, and all three were measured on `small`, seed 1337, so the
embedder's contribution is not a guess:

| `--embedder=` | resolved | R@1 | R@10 | MRR | preference R@10 |
| --- | --- | --- | --- | --- | --- |
| `hash` (default) | `src:hash-bow-512` from `src/retrieval/embedder.ts` | 0.0% | 51.1% | 0.149 | 16.7% |
| `bench-hash` | `hash-256d`, frozen bench-local | 0.0% | 44.3% | 0.159 | 0.0% |
| `minilm` | `transformers:Xenova/all-MiniLM-L6-v2`, real encoder | 0.0% | 50.0% | 0.189 | 16.7% |

Two things follow, and both matter for how these numbers get quoted:

- **A real sentence encoder does not rescue `naive-rag`.** minilm scores *below* the
  lexical hashing embedder on `recall@10` (50.0% vs 51.1%) and only improves `MRR`. So
  `naive-rag`'s weakness here is **not** an artifact of using an offline embedder — the
  bottleneck is chunk-level retrieval with no memory-level priors. Do not attribute these
  numbers to embedding quality.
- **The default is not frozen.** `hash` prefers `src/retrieval/embedder.ts` so `naive-rag`
  and the hybrid system share one embedding backend and the comparison isolates retrieval
  *strategy*. That module is under active development, so the default baseline can move
  when it changes (it is 512d bag-of-words with a stemming tokenizer; the bench-local
  fallback is 256d unigram+bigram, worth ~7 points of `recall@10`). Use
  `--embedder=bench-hash` when you need a baseline that cannot move underneath you.

Every run prints and records which embedder was actually resolved
(`config.embedderResolved`, `config.embedderFromSrc`). Note that `src/retrieval/embedder.ts`
did not exist when this harness was started and appeared mid-session; if a number in an old
report has no `embedderResolved` field, you cannot tell which backend produced it.

`src/retrieval/embedder.ts` declares the same `EmbeddingProvider` contract with different
property names (`id`/`dims` rather than `name`/`dimensions`); `bench/embedder.ts` adapts it
rather than casting, so the report cannot print `embedder=undefined`.

#### `supermemory` — env vars

Skips cleanly with `SUPERMEMORY_API_KEY not set, skipping` when unconfigured.

| env var | required | default |
| --- | --- | --- |
| `SUPERMEMORY_API_KEY` | **yes** | — |
| `SUPERMEMORY_BASE_URL` | no | `https://api.supermemory.ai` |
| `SUPERMEMORY_SEARCH_MODE` | no | `hybrid` (`memories`/`hybrid`/`documents`) |
| `SUPERMEMORY_BATCH_SIZE` | no | `25` (max 100) |
| `SUPERMEMORY_REQUEST_DELAY_MS` | no | `150` |
| `SUPERMEMORY_CONTAINER_TAG` | no | `mcir-<runId>` |

**This adapter has never been run against the live service** — no API key was available
when it was written. It is built strictly from the published OpenAPI document at
`https://api.supermemory.ai/v4/openapi` and the docs at `https://supermemory.ai/docs`; no
endpoint is invented. It uses `POST /v4/memories` for ingest (documented as "generates
embeddings and makes them immediately searchable") rather than `POST /v3/documents`, whose
ingestion is asynchronous and returns `status: "queued"` — polling lag there would be
silently recorded as retrieval failure. Search is `POST /v4/search`, which returns
`results[].id` + `results[].similarity` (note: `/v3/search` instead returns `documentId` +
`score`; do not share a parser between them). Teardown is a best-effort
`DELETE /v3/documents/bulk` scoped to the run's container tag.

### Reproducibility

- **The fixtures are deterministic.** Same `--size` and `--seed` produces a byte-identical
  JSON file. All randomness comes from a seeded PRNG (`bench/rng.ts`); there is no bare
  `Math.random()` and no wall-clock value in any fixture. Timestamps are stored as
  relative `dayOffset` / `minuteOfDay` and resolved against `--time-anchor` at run time.
- **All rank-based metrics are reproducible.** Verified: `recall@k`, `allGold@k`,
  `nDCG@10`, `foundRate` and `staleRate` are bit-identical across repeated runs and across
  a simulated 12-hour clock shift, for every system.
- **Absolute scores drift slightly, and one caveat follows from it.**
  `src/utils.ts recencyScore()` reads `Date.now()` at score time, which the harness cannot
  control. Consequences: the abstention `tau` (a score) moves in roughly the 8th decimal
  between runs, and `enhanced` — whose score mixes recency with temporal boosts — shows
  about 0.1% relative movement in `MRR`/`meanRank` from occasional near-ties flipping. All
  `recall@k` values are unaffected. Pass an explicit `--time-anchor` for a fixed run.
- Related trap, now fixed, worth knowing about: `recencyScore()` does
  `Math.max(ageDays, 0)`, so a *future* timestamp pins recency at exactly `1.0` and then
  drifts off that clamp as the day advances. An earlier version of `materialize()` allowed
  future timestamps and in-memory's `recall@1` moved 5.7 points over a single day.
  `materialize()` now places every timestamp strictly before the anchor.
- Corpus records use `decayPolicy: { kind: "none" }` on purpose. With a TTL policy the
  providers archive the entire corpus and every score goes to zero — a harness artifact,
  not a system property.
- The run JSON records the exact command, argv, dataset name/version/hash/seed/size, git
  SHA, whether the tree was dirty, node version, platform, retrieval depth, embedder and
  time anchor, so any number can be traced back to the run that produced it.

---

## 2. LongMemEval_S — public dataset, our harness

**[`longmemeval/`](longmemeval/README.md)** · dataset: **[`longmemeval/DATA.md`](longmemeval/DATA.md)**
· evidence: **[`longmemeval/results/`](longmemeval/results/README.md)**

```bash
cd bench/longmemeval && npm install
# download the dataset per DATA.md, then:
./run-modeA.sh                          # retrieval only. Free, offline, ~20 min.
./run-hybrid-subset.sh                  # hybrid retrieval, 150-question subset
OPENROUTER_API_KEY=... ./run-modeB.sh   # QA + LLM judge. ~$0.86.
```

**Two configurations, two question sets, never one number.** The full-500 run
(n = 479 scored) measures `memory-core` with **`embedder=none` — that row is BM25-only.**
Hybrid retrieval was measured separately on a 150-question stratified subset
(n = 142 scored) because embedding every haystack turn costs ~250 core-seconds per
question. Those are different denominators and **must not be combined.** The QA-accuracy
numbers are likewise produced on BM25-only retrieval; no Mode B run on hybrid retrieval
exists, so no hybrid QA number should be quoted.

## 3. LoCoMo — public dataset, our harness, head-to-head with mem0

**[`locomo/`](locomo/README.md)** · dataset: **[`locomo/DATA.md`](locomo/DATA.md)**
· evidence: **[`locomo/results/`](locomo/results/README.md)**

```bash
cd bench/locomo && npm install
# download the dataset per DATA.md, then:
./mode_a.sh                             # retrieval only. Free, offline, minutes.
./mode_a.sh --with-hybrid               # also the embedder configurations
./mode_a.sh --with-mem0                 # also mem0's LLM write path. Hours, ~$3.45.
OPENROUTER_API_KEY=... ./mode_b.sh      # QA + LLM judge. ~$3.70.
python3 oracle_matched.py               # matched denominators for the oracle comparison
```

mem0 is given one `add()` per dialogue turn (matching our granularity), its own default
score gate is disabled the same way ours is, and at read time it is given its own
consolidated memory texts rather than the original turns. Because mem0 rewrites and
consolidates, its retrievals are mapped back to gold turns through **three** attribution
channels — an exact one plus a deliberate lower and upper bound — and all three are in
the report. The published row is the exact middle channel.

---

## Which artifact backs which table

Every number in the repository README's "Retrieval quality" section traces to a file
here. Nothing is quoted that is not committed.

| README table / claim | artifact | n |
|---|---|---|
| Synthetic suite, 5-row system table | `out/*.json` from `run.ts` (regenerate: see Quick start) | 44 |
| LongMemEval, 5-row system table | [`longmemeval/results/modeA-fast.json`](longmemeval/results/modeA-fast.json) | 479 |
| LongMemEval, `rrfK=5` .8716 vs `rrfK=60` .8648 | [`longmemeval/results/modeA-hybridsub.json`](longmemeval/results/modeA-hybridsub.json) | 142 |
| LongMemEval, hybrid vs BM25-only on equal footing | [`longmemeval/results/modeA-subset150.json`](longmemeval/results/modeA-subset150.json) | 142 |
| LongMemEval, QA accuracy 62.6 / 69.5 / 82.0 % | [`longmemeval/results/modeB-full.json`](longmemeval/results/modeB-full.json) | 479 / 479 / 150 |
| LongMemEval, deprecated-provider table | [`longmemeval/results/modeA-fast.json`](longmemeval/results/modeA-fast.json) | 479 |
| LoCoMo, 5-row rank-metric table | [`locomo/results/mode_a.json`](locomo/results/mode_a.json) | 1,531 |
| LoCoMo, matched-denominator QA (.485 / .476 / .451) | [`locomo/results/oracle_matched.txt`](locomo/results/oracle_matched.txt) | 233 |
| LoCoMo, ingest-cost table | [`locomo/results/mode_a.json`](locomo/results/mode_a.json) → `.systems[].ingest` | — |

Each `results/README.md` maps individual rows to individual JSON paths, and explains the
sanity checks and the exclusions.

Every artifact carries the git SHA it was produced at, the dataset sha256, the model ids
and the command line. Infrastructure identifiers (the hostname and absolute paths of the
machine the runs executed on) were rewritten to placeholders on import; each artifact
discloses that in a `_redaction` field. No metric, denominator, hash or model id was
altered.

## Layout

```
bench/
  README.md            this file
  run.ts               CLI runner, table output + JSON
  metrics.ts           recall@k, allGold@k, MRR, nDCG, meanRank, staleRate, abstention, latency
  embedder.ts          EmbeddingProvider iface, HashEmbedder, transformers option, src/ resolution
  rng.ts               seeded PRNG, unique/disjoint entity pools
  tokenize.ts          bench-local tokenizer (deliberately not src/utils, so baselines stay frozen)
  types.ts             BenchSystem, EvalItem, Dataset, MemoryRecord materialization
  tsconfig.json        typecheck: npx tsc -p bench/tsconfig.json --noEmit
  dataset/
    spec.ts            vocabulary pools, the six families' templates, validateDataset()
    generate.ts        CLI + load/materialize helpers
    generated/         committed fixtures (inspectable, diffable)
  systems/
    index.ts           registry
    provider.ts        any MemoryProvider from src/provider.ts
    bm25.ts  random.ts  naive-rag.ts  supermemory.ts
  out/                 per-run artifacts (gitignored)

  longmemeval/         LongMemEval_S harness — see longmemeval/README.md
    DATA.md            dataset source + sha256 (dataset itself NOT committed)
    results/           committed evidence for the published tables
    data/ work/ out/   gitignored
  locomo/              LoCoMo harness incl. the mem0 head-to-head — see locomo/README.md
    DATA.md            dataset source + sha256 (dataset itself NOT committed)
    requirements.txt   Python deps for the mem0 comparison (own venv, not the root package.json)
    results/           committed evidence for the published tables
    data/ work/ out/   gitignored
```

Both public-dataset harnesses carry their own `package.json` and `tsconfig.json`, and are
deliberately **not** wired into the root `package.json`: a memory library should not carry
a benchmark's dependency tree. Neither reads a secret from disk — `OPENROUTER_API_KEY`
comes from the environment or the run fails with a message saying so.

## Appendix: a note on `enhanced` (synthetic suite)

This harness measures `MemoryProvider.search()`. The hardcoded gold-answer string in
`src/providers/enhanced-provider.ts` (`extractIntelligentAnswer`, which returns the literal
`"GPS system not functioning correctly"`) sits on the `buildEnhancedContext()` path, not on
`search()`. So these numbers are **not** inflated by that injection — but they also do not
measure it. Any claim about answer quality needs a separate answer-level eval, and that
injection needs removing before such an eval means anything.
