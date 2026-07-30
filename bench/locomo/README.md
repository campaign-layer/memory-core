# LoCoMo harness

Runs **memory-core's own providers**, a lexical BM25 reference, a random control, and
**mem0 OSS** over the public [LoCoMo](https://arxiv.org/abs/2402.17753) dataset. Every
system reads one canonical corpus file and is graded by one scorer, so the head-to-head
is same-harness by construction rather than by convention.

> **These are not leaderboard scores.** The corpus construction, retrieval granularity,
> reader model and judge model here are ours. Numbers published in the LoCoMo paper, in
> mem0's own materials, or in any vendor's blog post were measured differently and **must
> not be compared to anything this harness produces.** The only valid comparisons are
> *within* one report.
>
> The mem0 rows are **our measurement of mem0**, run by us through this harness — not
> mem0's published numbers. That is what makes putting them in the same table legitimate.

## Setup

```bash
cd bench/locomo
npm install                                  # tsx + typescript, for the retrieval and scoring steps
```

Then get the dataset — **[DATA.md](DATA.md)** has the source, the exact sha256 and where
to put it.

Node >= 20 and Python 3.10+. The Python side is only needed for parts of the pipeline:

| stage | needs |
|---|---|
| `build_corpus.py`, `audit_leakage.py`, `validate_evidence.py` | stdlib only |
| `run_mode_b.py`, `score_mode_b.py` (QA + judge) | `httpx` |
| `run_mem0.py`, `attribute_mem0.py` (the mem0 comparison) | `mem0ai`, `sentence-transformers`, `qdrant-client` |

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

`requirements.txt` pins `mem0ai==2.0.14` — the version the committed results were
produced with. A different mem0 version is a different system, and the artifacts label
every mem0 row `mem0 OSS 2.0.14`.

This is deliberately **not** wired into the root `package.json`: a memory library should
not carry a benchmark's Python dependency tree.

## Run it

### Mode A — retrieval only.

```bash
./mode_a.sh                  # in-repo providers + bm25 + random. Free, offline, minutes.
./mode_a.sh --with-hybrid    # also the local-ONNX embedder configurations. Free, slower.
./mode_a.sh --with-mem0      # also mem0's LLM write path. HOURS, COSTS MONEY (~$3.45).
```

Builds the canonical corpus, runs retrieval, attributes mem0's memories back to gold
turns if mem0 output exists, scores everything with one grader, and runs the leakage
audit. Writes `out/mode_a.json`, `out/mode_a.txt`, `out/audit.txt`. Checkpointed per
conversation.

### Mode B — QA accuracy with an LLM reader and judge. Costs money.

```bash
export OPENROUTER_API_KEY=...
./mode_b.sh                                     # every system that has rankings
./mode_b.sh "memory-core:in-memory,oracle" 20   # explicit systems, concurrency 20
```

The recorded full run was 48,270 LLM calls / 28.6 M prompt tokens / $3.70. Checkpointed
per (system, k, question).

Then, because the oracle upper bound runs on a subsample:

```bash
python3 oracle_matched.py    # restricts every system to the oracle's question set
```

**Use the matched-denominator table for any oracle comparison.** Reading full-set
accuracy against the oracle mixes denominators.

### Diagnostics

```bash
python3 audit_leakage.py       # the leakage audit — run this before believing anything
python3 validate_evidence.py   # dataset-level evidence sanity
python3 channel_diff.py        # how far apart the three mem0 attribution channels are
python3 mem0_totals.py         # mem0 ingest cost and wall clock, per conversation
python3 compare_reasoning.py   # does disabling model reasoning change what mem0 stores
python3 show_meta.py           # embedder / rrfK / vector-liveness of each ranking run
npm run typecheck
```

## What makes the mem0 comparison fair

mem0 **rewrites and consolidates** — a retrieved mem0 memory is not a corpus turn, so it
cannot simply be scored against gold turn ids. `attribute_mem0.py` produces three
attribution channels and the report carries all three:

| channel | attribution rule | bias |
|---|---|---|
| `mem0` | exact event-log provenance: every turn whose ingestion ADDed or UPDATEd the memory | **neither** — mem0's own bookkeeping |
| `mem0-metadata` | only the turn that first created the memory | **against** mem0 (later UPDATEs uncredited) |
| `mem0-textmatch` | event log ∪ lexical containment | **for** mem0 (a memory can resemble a turn it never came from) |

Every channel is **query-independent** — attribution never looks at the question or the
gold answer. The headline row is the exact middle channel; publishing only the channel
that flatters us would be the failure mode this bracketing exists to prevent.

Other things held equal on purpose:

- **Same corpus.** Every system reads `work/corpus.json`. `run_retrieval.ts` recomputes
  its `corpus_sha256` and refuses to run on a mismatch.
- **Same granularity.** mem0 gets one `add()` per dialogue turn, matching memory-core's
  one-memory-per-turn ingest, so mem0's extract → compare → ADD/UPDATE/DELETE write path
  is exercised exactly as shipped.
- **Same score gate.** `minScore=0` for memory-core and `threshold=0.0` for mem0 — both
  measure *ranking*, not each system's own default gate.
- **Same native unit at read time.** In Mode B, mem0 is given its own consolidated memory
  texts, not the original turns. Substituting the turns would credit mem0 with
  information its write path discarded.
- **Same model behaviour.** Reasoning is disabled for the answerer, the judge and mem0's
  write path alike; `compare_reasoning.py` quantifies what that choice costs rather than
  assuming it is free.

Two harness artifacts are reported rather than hidden: `decayPolicy` is set to `none`
(memory-core's shipped default is `time`/180d and every LoCoMo session predates that
window, so the default would expire the entire corpus), and category 5 questions are
adversarial-by-construction so they carry no retrieval gold and are scored only as an
abstention task in Mode B.

## Layout

```
*.py, *.ts, *.sh   the harness
DATA.md            where to get the dataset (not committed)
results/           committed evidence for the published tables — never written to
out/               YOUR run output    (gitignored)
work/              corpus, rankings, mem0 dumps, logs (gitignored)
data/              the dataset        (gitignored)
```

Paths are all overridable: `LOCOMO_DATA`, `LOCOMO_WORK`, `LOCOMO_OUT`, `LOCOMO_PY`,
`LOCOMO_TSX`. Secrets come from the environment only — nothing reads a key off disk.
