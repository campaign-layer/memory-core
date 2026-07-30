#!/usr/bin/env bash
# LoCoMo MODE A -- retrieval-only comparison. One command.
#
#   ./mode_a.sh                 in-repo systems + baselines (free, offline)
#   ./mode_a.sh --with-hybrid   also the two hybrid (local ONNX embedder) variants
#   ./mode_a.sh --with-mem0     also mem0's LLM write path first (HOURS, COSTS MONEY)
#
# Everything is checkpointed: re-running resumes rather than recomputing.
# Needs the dataset (see DATA.md) and `npm install` here. Only --with-mem0 needs the
# Python venv from requirements.txt.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

DATA="${LOCOMO_DATA:-$HERE/data/locomo10.json}"
if [ ! -f "$DATA" ]; then
  echo "error: LoCoMo dataset not found at $DATA" >&2
  echo "       See $HERE/DATA.md for the download command and expected sha256." >&2
  exit 1
fi

TSX=""
for candidate in "${LOCOMO_TSX:-}" "$HERE/node_modules/.bin/tsx" "$HERE/../../node_modules/.bin/tsx"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then TSX="$candidate"; break; fi
done
if [ -z "$TSX" ]; then
  echo "error: tsx not found. Run 'npm install' in $HERE (or the repo root), or set LOCOMO_TSX." >&2
  exit 1
fi

WORK="${LOCOMO_WORK:-$HERE/work}"
OUT="${LOCOMO_OUT:-$HERE/out}"
# Only the mem0 stages need the venv; keep it optional so the free path always runs.
PY="${LOCOMO_PY:-$HERE/.venv/bin/python}"
mkdir -p "$WORK" "$OUT"

echo "== 1. build the canonical corpus (single source of truth for every system) =="
python3 build_corpus.py --out "$WORK/corpus.json" >/dev/null
python3 - "$WORK/corpus.json" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))["meta"]
print(f"   {m['n_conversations']} conversations, {m['n_turns']} turns, "
      f"{m['n_questions']} questions, corpus_sha={m['corpus_sha256'][:16]}")
PY

echo "== 2. in-repo systems + baselines (memory-core providers, bm25, random) =="
"$TSX" run_retrieval.ts --corpus="$WORK/corpus.json" --out="$WORK/rankings" \
  --systems=memory-core:in-memory,memory-core:dual-layer,memory-core:enhanced,bm25,random \
  | grep -E 'corpus ok|done'

if [ "${1:-}" = "--with-hybrid" ]; then
  echo "== 2b. hybrid variants (local ONNX embedder; slow, still free) =="
  ./run_hybrid_all.sh
fi

if [ "${1:-}" = "--with-mem0" ]; then
  if [ ! -x "$PY" ]; then
    echo "error: mem0 venv not found at $PY. See README.md for setup, or drop --with-mem0." >&2
    exit 1
  fi
  echo "== 3. mem0 ingest + search (LLM write path; HOURS, COSTS MONEY) =="
  ./launch_mem0.sh
  echo "   launched detached; waiting for all conversations to finish"
  n_conv="$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["conversations"]))' "$WORK/corpus.json")"
  while [ "$(ls "$WORK"/mem0/*.done.json 2>/dev/null | wc -l)" -lt "$n_conv" ] \
     && [ "$(pgrep -cf '[r]un_mem0.py')" -gt 0 ]; do sleep 60; done
fi

if ls "$WORK"/mem0/*.done.json >/dev/null 2>&1; then
  echo "== 4. attribute mem0 memories back to gold turns (3 channels) =="
  "$PY" attribute_mem0.py --corpus "$WORK/corpus.json" --mem0-dir "$WORK/mem0" \
    --out "$WORK/rankings" > "$OUT/mem0_attribution.txt"
  echo "   wrote mem0 / mem0-metadata / mem0-textmatch rankings"
fi

echo "== 5. score (reuses bench/metrics.ts, one grader for every system) =="
"$TSX" score_mode_a.ts --corpus="$WORK/corpus.json" --rankings="$WORK/rankings" \
  --out="$OUT/mode_a.json" | tee "$OUT/mode_a.txt"

echo "== 6. leakage audit =="
python3 audit_leakage.py | tee "$OUT/audit.txt"
