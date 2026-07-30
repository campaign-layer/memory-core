# LongMemEval harness

Runs **memory-core's own providers**, plus a lexical BM25 reference and a random control,
over the public [LongMemEval_S](https://arxiv.org/abs/2410.10813) dataset through one
ingest → search path, so every row is same-harness by construction.

> **These are not leaderboard scores.** The retrieval granularity (one memory per
> conversation turn), the corpus construction, the reader model and the judge model here
> are ours. Numbers published in the LongMemEval paper or in any vendor's blog post were
> measured differently and **must not be compared to anything this harness produces.**
> The only valid comparisons are *within* one report.

## Setup

```bash
cd bench/longmemeval
npm install                  # tsx + typescript (this harness only; not wired into the root package.json)
```

Then get the dataset — **[DATA.md](DATA.md)** has the source, the exact sha256 and where
to put it. It is 278 MB of third-party data and is deliberately not committed.

Node >= 20. No Python.

## Run it

### Mode A — retrieval only. Free, offline, no API key.

```bash
./run-modeA.sh                          # full 500 questions, ~20 min
./run-modeA.sh --limit=10 --tag=smoke   # 10-question smoke test first
```

First invocation splits the 278 MB dataset into one file per question (a few minutes,
needs ~8 GB of node heap); later invocations skip it. Writes
`out/modeA-<tag>.{json,md}`. Fully resumable — re-run the same command.

### Hybrid retrieval — a separate run on a stratified subset.

```bash
./run-hybrid-subset.sh                  # all systems on 150 questions
ONLY_HYBRID=1 ./run-hybrid-subset.sh    # just the two hybrid variants
```

The hybrid systems embed every haystack turn with a real ONNX sentence encoder (~250
core-seconds per question), so the full 500 would occupy a large machine for hours. The
subset is scored for **every** system, so the comparison stays same-harness and
same-questions — but **n = 142 scored is a different denominator from the full run's
n = 479, and the two must never be combined.**

### Mode B — QA accuracy with an LLM reader and judge. Costs money.

```bash
export OPENROUTER_API_KEY=...
./run-modeB.sh                          # ~$0.86, 6.15 M prompt tokens
./run-modeB.sh --limit=10 --tag=smoke   # cheap smoke test first
```

Reads Mode A's ranking for the `memory-core` system, so run Mode A first. Resumable per
(condition, question).

### Integrity checks

```bash
npx tsx verify-no-leak.ts       # proves no gold label or answer reaches the ranker
npx tsx preflight-hybrid.ts     # proves the vector leg is actually live (before trusting any hybrid number)
npm run typecheck
```

`verify-no-leak.ts` exits non-zero on any finding, so it can gate a run. This repository
previously "scored" 27.9% on LongMemEval by hardcoding gold answers, which is why this is
verified per run rather than assumed.

## The two configurations, and why they are not one number

| system name | configuration | typical run |
|---|---|---|
| `bm25` | Okapi BM25, lexical only | reference point |
| `memory-core` | `kind=in-memory`, **`embedder=none` → BM25-only** | full 500 |
| `memory-core-hybrid-k5` | BM25 ∥ local ONNX vector, RRF `k=5` | 150-question subset |
| `memory-core-hybrid-k60` | same, RRF `k=60` (the provider default) | 150-question subset |
| `random` | seeded shuffle control | mandatory sanity floor |
| `mc-enhanced`, `mc-dual-layer` | the deprecated provider kinds | full 500 |

`memory-core` is **BM25-only**. It is a different configuration from
`memory-core-hybrid-*`, measured on a different question set. `aggregate.ts` prints the
configuration next to every system name for exactly this reason. See
[`results/README.md`](results/README.md).

## What the harness refuses to do

- **Report BM25 as hybrid.** The provider degrades to BM25-only *by design* if the
  embedder fails to load, which would produce a plausible-looking fake hybrid result. Any
  hybrid system aborts the shard unless stored vectors cover the whole corpus and
  retrieved hits carry a vector credit.
- **Merge results across commits.** Each result row is stamped with the git SHA by the
  *worker that produced it*, not by the scorer. The aggregator flags mixed SHAs, because
  a checkout that moves mid-run otherwise yields spliced numbers with consistent-looking
  provenance.
- **Hide excluded questions.** The 21 zero-gold (`*_abs`) questions have no retrieval
  target, so they are excluded from every retrieval metric — and listed by id in the
  report rather than silently dropped. In Mode B they are scored with the opposite rubric
  and reported separately.
- **Let a label reach the ranker.** Indexed text is `role: content` and nothing else — no
  date, no gold flag, no session id. `confidence`, `importance` and `memoryType` are
  constant across every turn, so the provider's quality term cannot encode a label.

## Layout

```
*.ts, *.sh        the harness
DATA.md           where to get the dataset (not committed)
results/          committed evidence for the published tables — never written to
out/              YOUR run output          (gitignored)
work/             dataset split + manifest (gitignored)
data/             the dataset              (gitignored)
```

Paths are all overridable: `LME_DATASET`, `LME_DATA_DIR`, `LME_WORK_DIR`, `LME_OUT_DIR`,
`LME_TSX`. Secrets come from the environment only — nothing reads a key off disk.
