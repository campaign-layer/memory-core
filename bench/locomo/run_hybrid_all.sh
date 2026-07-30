#!/usr/bin/env bash
# LoCoMo retrieval for the memory-core embedder configurations.
#
#   ./run_hybrid_all.sh                     run against this checkout
#   MC_REPO=/path/to/worktree ./run_hybrid_all.sh   run against a pinned worktree
#
# Produces three rankings, deliberately named for what they ARE:
#   memory-core-bm25          embedder=none  (the shipped default; NOT hybrid)
#   memory-core-hybrid-rrf5   embedder=local, RRF k=5
#   memory-core-hybrid-rrf60  embedder=local, RRF k=60
#
# Free (local ONNX embedder, no API calls) but slow: the recorded run took ~104 s of
# ingest for 5,882 turns plus per-query search.
#
# XCHECK_REPO=<dir> additionally re-runs BM25-only from a second worktree and diffs
# the two rankings, which is how a mid-run checkout move gets caught.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

TSXBIN=""
for candidate in "${LOCOMO_TSX:-}" "$HERE/node_modules/.bin/tsx" "$HERE/../../node_modules/.bin/tsx"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TSXBIN="$candidate"; break; fi
done
if [ -z "$TSXBIN" ]; then
  echo "error: tsx not found. Run 'npm install' in $HERE (or the repo root), or set LOCOMO_TSX." >&2
  exit 1
fi

WORK="${LOCOMO_WORK:-$HERE/work}"
if [ ! -f "$WORK/corpus.json" ]; then
  echo "error: canonical corpus not found at $WORK/corpus.json. Run ./mode_a.sh first." >&2
  exit 1
fi

# Keep the sentence-encoder model cache inside the harness rather than in $HOME.
export HF_HOME="${HF_HOME:-$HERE/hf-cache}"
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
export ORT_NUM_THREADS="${ORT_NUM_THREADS:-4}"

REPO="${MC_REPO:-$HERE/../..}"
TSX="nice -n 10 $TSXBIN"

echo "### 1/3 BM25-only (embedder=none, the shipped default) ###"
$TSX run_retrieval2.ts --repo="$REPO" --name=memory-core-bm25 --embedder=none || exit 1
echo "### 2/3 hybrid rrfK=5 ###"
$TSX run_retrieval2.ts --repo="$REPO" --name=memory-core-hybrid-rrf5 --embedder=local --rrfk=5 || exit 1
echo "### 3/3 hybrid rrfK=60 (the provider default) ###"
$TSX run_retrieval2.ts --repo="$REPO" --name=memory-core-hybrid-rrf60 --embedder=local --rrfk=60 || exit 1

if [ -n "${XCHECK_REPO:-}" ]; then
  echo "### reproducibility cross-check against $XCHECK_REPO ###"
  rm -rf "$WORK/rankings_xcheck"
  $TSX run_retrieval2.ts --repo="$XCHECK_REPO" --name=memory-core-bm25-xcheck \
    --embedder=none --out="$WORK/rankings_xcheck" || exit 1
  python3 - "$WORK" <<'PY'
import json, os, sys
work = sys.argv[1]
def load(p):
    d = {}
    for line in open(p):
        if line.strip():
            r = json.loads(line)
            d[r["qid"]] = [t for it in r["items"] for t in it["turn_ids"]]
    return d
a = load(os.path.join(work, "rankings", "memory-core_in-memory.jsonl"))
b = load(os.path.join(work, "rankings_xcheck", "memory-core-bm25-xcheck.jsonl"))
same = sum(1 for k in a if a[k] == b.get(k))
print(f"in-memory vs xcheck identical rankings: {same}/{len(a)}")
c = load(os.path.join(work, "rankings", "memory-core-bm25.jsonl"))
same2 = sum(1 for k in a if a[k] == c.get(k))
print(f"in-memory vs pinned BM25-only identical: {same2}/{len(a)}")
PY
fi
echo "### ALL RETRIEVAL RUNS DONE ###"
