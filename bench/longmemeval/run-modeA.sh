#!/usr/bin/env bash
# LongMemEval Mode A -- retrieval only. No API key, no network, no cost.
#
#   ./run-modeA.sh                          full 500 questions, all systems
#   ./run-modeA.sh --limit=10 --tag=smoke    10-question smoke test
#   SYSTEMS=bm25,memory-core ./run-modeA.sh  only those two systems
#   SHARDS=4 ./run-modeA.sh                  4 parallel shards instead of 12
#
# Writes JSONL shards under out/modeA/<system>/ and a report to
# out/modeA-<tag>.{json,md}. Everything is resumable: re-run the same command.
#
# Needs the dataset (see DATA.md) and `npm install` in this directory.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

# tsx: this harness's own install first, then the repo root.
TSX=""
for candidate in "${LME_TSX:-}" "$HERE/node_modules/.bin/tsx" "$HERE/../../node_modules/.bin/tsx"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TSX="$candidate"; break; fi
done
if [ -z "$TSX" ]; then
  echo "error: tsx not found. Run 'npm install' in $HERE (or the repo root), or set LME_TSX." >&2
  exit 1
fi

# Always spawn the SAME node that runs this script: invoking node_modules/.bin/tsx
# directly follows its '#!/usr/bin/env node' shebang, which may be an older node.
NODE="${NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then echo "error: node not found on PATH (node >= 20 required)" >&2; exit 1; fi

DATASET="${LME_DATASET:-$HERE/data/longmemeval_s.json}"
if [ ! -f "$DATASET" ]; then
  echo "error: LongMemEval_S not found at $DATASET" >&2
  echo "       It is a 278 MB third-party dataset and is deliberately not committed." >&2
  echo "       See $HERE/DATA.md for the download command and expected sha256." >&2
  exit 1
fi

SYSTEMS="${SYSTEMS:-bm25,memory-core,random,mc-enhanced,mc-dual-layer}"
SHARDS="${SHARDS:-12}"
WORK_DIR="${LME_WORK_DIR:-$HERE/work}"

# onnxruntime (the hybrid systems) would otherwise start a thread pool per shard and
# oversubscribe every core on the machine.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"

if [ ! -f "$WORK_DIR/manifest.json" ]; then
  echo "== prepare: splitting the 278 MB dataset into one file per question (one time) =="
  "$NODE" --max-old-space-size=8192 "$TSX" "$HERE/prepare.ts"
fi

exec "$NODE" "$TSX" "$HERE/modeA.ts" --shards="$SHARDS" --systems="$SYSTEMS" "$@"
