# LongMemEval — committed evidence

These are the **unmodified reports** the harness emitted for the runs quoted in the
repository README, except for one disclosed redaction (see bottom). They are checked in
so any published number can be traced to a command, a git SHA and a dataset hash.

**The harness never writes here.** Your own runs land in `out/` (gitignored). That
separation is deliberate: re-running must not silently overwrite the provenance record.

Every artifact below was produced at memory-core `5ea3852`, on LongMemEval_S
`sha256:08d8dad4be43ee20…`, node v22.14.0.

---

## THE ONE THING TO GET RIGHT

There are **two different retrieval configurations** here, measured on **two different
question sets**. They are separate runs with separate denominators.

| | configuration | question set | artifact |
|---|---|---|---|
| `memory-core` | **BM25-only** — `kind=in-memory`, `embedder=none`, vector leg never runs | 500 selected, **n = 479** scored | `modeA-fast.*` |
| `memory-core-hybrid-k5` / `-k60` | **hybrid** — BM25 ∥ local ONNX vector, fused by RRF | 150 selected, **n = 142** scored | `modeA-hybridsub.*`, `modeA-subset150.*` |

**Do not merge a hybrid row into the n = 479 table, and do not describe the n = 479
`memory-core` row as hybrid.** The evidence that the n = 479 row is BM25-only is in the
artifact itself, in two independent places:

```
$ jq -r '.systems["memory-core"].runTimeProvenance.note' modeA-fast.json
src/providers/factory.ts (kind=in-memory, embedder=none)

$ jq -r '.systems["memory-core"].vectorLiveness' modeA-fast.json
null            # no vector diagnostics recorded at all
```

and the report's own sanity block records `memory-core vector liveness: 0.0% of hits
vector-credited, 0/500 questions fully embedded`. By contrast `modeA-hybridsub.json`
records `99.5%` of hits vector-credited and `150/150` questions fully embedded.

`aggregate.ts` now prints the configuration next to every system name, so a future
report cannot produce a bare "memory-core" row that reads as hybrid.

---

## Which artifact backs which published table

### README table: "2. LongMemEval_S — public dataset, our harness" (n = 479)

**`modeA-fast.json` / `modeA-fast.md`**

| README row | artifact path |
|---|---|
| `memory-core` .3429 / .8023 / .8892 / .6479 / 20.8 | `.systems["memory-core"].overall` |
| `bm25 baseline` .3619 / .7797 / .8679 / .6459 / 28.8 | `.systems["bm25"].overall` |
| `mc-dual-layer` .0494 / .4764 / … / 52.7 | `.systems["mc-dual-layer"].overall` |
| `mc-enhanced` .0565 / .1254 / … / 274.3 | `.systems["mc-enhanced"].overall` |
| `random control` .0017 / .0139 / … / 351.9 | `.systems["random"].overall` |

Command: `SYSTEMS=bm25,memory-core,random,mc-enhanced,mc-dual-layer ./run-modeA.sh --tag=fast`

This table is **entirely BM25-only** for the memory-core row. It also backs the README's
"Deprecated: `enhanced` and `dual-layer`" table and the retraction paragraph's
"`enhanced`'s actual measured LongMemEval R@10 is .1254, against a .0139 random floor".

### README sentence: "hybrid … `rrfK=5` scores R@10 .8716 against `rrfK=60`'s .8648"

**`modeA-hybridsub.json` / `modeA-hybridsub.md`** — n = 142 scored of 150 selected.

Command: `ONLY_HYBRID=1 ./run-hybrid-subset.sh`

### The same-questions comparison that makes the subset interpretable

**`modeA-subset150.json` / `modeA-subset150.md`** — all seven systems on those same 142
questions, so hybrid can be compared to BM25-only and to bm25 without changing the
denominator. On this subset `memory-core` (BM25-only) scores R@10 .8070 against
`memory-core-hybrid-k5` .8716 — that is the honest hybrid-vs-BM25 delta, and it is
**not** the same comparison as the n = 479 table.

Command: `./run-hybrid-subset.sh`

### README table: "Answer accuracy, with a `deepseek/deepseek-v4-flash` reader"

**`modeB-full.json` / `modeB-full.md`**

| README row | artifact path |
|---|---|
| retrieval @ k=10 → 62.6% | `.conditions.k10.answerable.accuracy` = 0.6263 (n = 479) |
| retrieval @ k=30 → 69.5% | `.conditions.k30.answerable.accuracy` = 0.6952 (n = 479) |
| oracle → 82.0% | `.conditions.oracle.answerable.accuracy` = 0.8200 (n = 150) |

Command: `./run-modeB.sh --tag=full --oracle-n=150`

**The retrieval feeding these numbers is `memory-core` — the BM25-only configuration.**
The README does not currently say so. There is no Mode B run on hybrid retrieval, so no
hybrid QA-accuracy number exists and none should be quoted.

The confidence intervals in the README (58.2–66.8 etc.) are Wilson intervals over the
`correct` / `n` counts in this file; they are not stored in the artifact.

Also note the abstention block: 21 `*_abs` questions scored with the **opposite** rubric
(declining is CORRECT), reported separately and never folded into the headline accuracy.

---

## Reading the sanity block

Every Mode A report ends with checks that would catch a broken or leaking harness. All
four artifacts here record `no flags`. The checks are:

- **random control vs analytic chance** — a leaking harness lifts the random control too,
  so this is the sharpest single test. `modeA-fast`: empirical R@10 .0139 vs analytic
  .0203, inside the 3-sigma tolerance.
- **single run-time SHA across all systems** — stamped by the *worker* that produced each
  row, not by the scorer, because a checkout that moves mid-run otherwise yields spliced
  numbers with consistent-looking provenance.
- **vector liveness** — any system named `hybrid` must prove its vector leg actually ran.
  The provider degrades to BM25-only *by design* when the embedder fails, which would
  otherwise produce a plausible-looking fake "hybrid" result.
- **at-or-below-random** — any system not convincingly above chance is named as such.
  This is what flagged `mc-enhanced`.

---

## Redaction

Each `.json` here carries a top-level `_redaction` field, and each `.md` a footer note,
recording that infrastructure identifiers — the machine hostname and absolute filesystem
paths on the box the run executed on — were rewritten to repo-relative placeholders when
these files were imported into the public repository.

Nothing verifiable was changed: git SHAs, dataset sha256 and byte count, model ids, every
metric, every denominator, and the full argument list of every command line are exactly
as the harness emitted them.
