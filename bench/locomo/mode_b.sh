#!/usr/bin/env bash
# LoCoMo MODE B -- QA accuracy with an LLM reader and judge, over the Mode A retrievals.
#
#   ./mode_b.sh                                  every system with rankings, k=10/30, + oracle
#   ./mode_b.sh "memory-core:in-memory,mem0" 20   explicit systems and concurrency
#
# COSTS MONEY and needs OPENROUTER_API_KEY. Checkpointed per (system, k, question);
# re-running resumes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "error: OPENROUTER_API_KEY is not set." >&2
  echo "       Mode B calls a reader and a judge model over OpenRouter." >&2
  echo "       Mode A (./mode_a.sh) needs no key and no network." >&2
  exit 1
fi

WORK="${LOCOMO_WORK:-$HERE/work}"
OUT="${LOCOMO_OUT:-$HERE/out}"
PY="${LOCOMO_PY:-$HERE/.venv/bin/python}"
if [ ! -x "$PY" ]; then
  # httpx is the only hard requirement for Mode B itself; fall back to system python3.
  PY="$(command -v python3)"
fi
if ! "$PY" -c 'import httpx' 2>/dev/null; then
  echo "error: $PY cannot import httpx, which run_mode_b.py needs." >&2
  echo "       See README.md for the venv setup (pip install -r requirements.txt)." >&2
  exit 1
fi

if [ ! -f "$WORK/corpus.json" ]; then
  echo "error: canonical corpus not found at $WORK/corpus.json. Run ./mode_a.sh first." >&2
  exit 1
fi

SYSTEMS="${1:-}"
CONC="${2:-20}"

if [ -z "$SYSTEMS" ]; then
  SYSTEMS="memory-core:in-memory,bm25,random,oracle"
  # mem0 joins automatically once its ingest has produced retrievals.
  if ls "$WORK"/mem0/*.search.jsonl >/dev/null 2>&1; then SYSTEMS="$SYSTEMS,mem0"; fi
fi

mkdir -p "$OUT" "$WORK/logs"

echo "== answering + judging (deepseek/deepseek-v4-flash, reasoning disabled) =="
echo "   systems: $SYSTEMS   k: 10,30   concurrency: $CONC"
"$PY" run_mode_b.py --corpus="$WORK/corpus.json" --rankings="$WORK/rankings" \
  --mem0-dir="$WORK/mem0" --systems="$SYSTEMS" --ks=10,30 --oracle-n=300 \
  --concurrency="$CONC" --checkpoint="$OUT/mode_b.jsonl" 2>&1 \
  | tee -a "$WORK/logs/mode_b.log"

echo "== scoring =="
"$PY" score_mode_b.py --checkpoint="$OUT/mode_b.jsonl" --corpus="$WORK/corpus.json" \
  --logs="$WORK/logs/mode_b.log" --out="$OUT/mode_b.json" | tee "$OUT/mode_b.txt"
