# memory-core retrieval benchmark harness

A reproducible harness for measuring **retrieval quality** of memory backends in this
repo, plus baselines to compare them against.

## Read this before quoting any number from here

The dataset is **synthetic and authored inside this repository**. Its internal name is
`memory-core-internal-retrieval` (MCIR).

- **It is NOT LongMemEval.** It is not LoCoMo, not MemGPT's suite, not any published
  benchmark. Numbers produced here are **not comparable** to published scores on those
  suites, and must never be presented as if they were.
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

## Quick start

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

### Flags

| flag | default | meaning |
| --- | --- | --- |
| `--systems=a,b,c` | `in-memory,file,enhanced,bm25,random,naive-rag` | systems to run. `random` is appended if omitted. |
| `--size=small\|large` | `small` | 50 items / 527 memories, or 500 items / 5267 memories |
| `--seed=N` | `1337` | dataset seed |
| `--k=N` | `10` | top-k reported in the headline table |
| `--json=path` | `bench/out/<runId>/results.json` | machine-readable output |
| `--embedder=hash\|bench-hash\|minilm` | `hash` | embedding backend for `naive-rag` |
| `--time-anchor=<iso>` | UTC midnight of the run day | corpus timestamps are placed relative to this |

## The six task families

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

### Label integrity

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

## Metrics

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

### Abstention, and why there are two numbers

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

### The random baseline is always printed

Non-negotiable. The `random` system runs even if you leave it out of `--systems`, and the
runner also prints a closed-form `[analytic random]` row: `E[recall@k] = k/N`,
`E[best gold rank]` and `E[MRR]` for a uniform random ranking over the same corpus, with
the depth cap folded in.

Any system whose `recall@10` is not convincingly above the analytic baseline gets a loud
`!! AT/BELOW RANDOM` line. This exists because a prior audit found a provider scoring
mean rank 2.5 on a 4-item corpus — exactly chance — and nothing in the repo would have
revealed it.

## Systems

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

### `naive-rag` — important caveat about the embedder

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

### `supermemory` — env vars

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

## Reproducibility

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
```

## A note on `enhanced`

This harness measures `MemoryProvider.search()`. The hardcoded gold-answer string in
`src/providers/enhanced-provider.ts` (`extractIntelligentAnswer`, which returns the literal
`"GPS system not functioning correctly"`) sits on the `buildEnhancedContext()` path, not on
`search()`. So these numbers are **not** inflated by that injection — but they also do not
measure it. Any claim about answer quality needs a separate answer-level eval, and that
injection needs removing before such an eval means anything.
