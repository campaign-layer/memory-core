#!/usr/bin/env bash
# LongMemEval hybrid retrieval on a 150-question stratified subset.
#
#   ./run-hybrid-subset.sh            all 7 systems on the subset (reproduces subset150)
#   ONLY_HYBRID=1 ./run-hybrid-subset.sh   just the two hybrid variants (reproduces hybridsub)
#
# WHY A SUBSET, AND WHY IT IS A SEPARATE NUMBER
# ---------------------------------------------
# The hybrid systems embed every haystack turn with a real ONNX sentence encoder
# (~250 core-seconds per question), so the full 500 would hold ~28 cores for 4-5
# hours. The subset is scored for EVERY system, so the comparison stays same-harness
# and same-questions -- but its denominator (n = 142 scored, 150 selected) is NOT the
# denominator of the full run (n = 479 scored, 500 selected).
#
# DO NOT merge a row from this run into the full-500 table. The full-500
# `memory-core` row is BM25-only (embedder=none); hybrid appears only here.
#
# No API key needed -- this is retrieval only.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

TSX=""
for candidate in "${LME_TSX:-}" "$HERE/node_modules/.bin/tsx" "$HERE/../../node_modules/.bin/tsx"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TSX="$candidate"; break; fi
done
if [ -z "$TSX" ]; then
  echo "error: tsx not found. Run 'npm install' in $HERE (or the repo root), or set LME_TSX." >&2
  exit 1
fi
NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then echo "error: node not found on PATH (node >= 20 required)" >&2; exit 1; fi

WORK_DIR="${LME_WORK_DIR:-$HERE/work}"
SUBSET="$WORK_DIR/subset-150.json"
N="${SUBSET_N:-150}"

if [ ! -f "$WORK_DIR/manifest.json" ]; then
  echo "error: dataset not prepared. Run ./run-modeA.sh first (it does the one-time split)." >&2
  exit 1
fi

if [ ! -f "$SUBSET" ]; then
  echo "== selecting the deterministic stratified subset (n=$N) =="
  "$NODE" "$TSX" "$HERE/subset.ts" --n="$N" --out="$SUBSET"
fi

echo "== preflight: proving the vector leg is actually live =="
"$NODE" "$TSX" "$HERE/preflight-hybrid.ts"

if [ -n "${ONLY_HYBRID:-}" ]; then
  SYSTEMS="memory-core-hybrid-k5,memory-core-hybrid-k60"
  TAG="${TAG:-hybridsub}"
else
  SYSTEMS="bm25,memory-core,memory-core-hybrid-k5,memory-core-hybrid-k60,random,mc-enhanced,mc-dual-layer"
  TAG="${TAG:-subset150}"
fi

# Shards default to 1: the shared per-process embedder cache is what makes the two
# rrfK variants share a single embedding pass over each corpus.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-4}"
exec "$NODE" "$TSX" "$HERE/modeA.ts" \
  --shards="${SHARDS:-1}" --systems="$SYSTEMS" --tag="$TAG" --subset="$SUBSET" "$@"
