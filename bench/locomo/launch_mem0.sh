#!/usr/bin/env bash
# Launches one mem0 process per LoCoMo conversation, detached, resumable.
# Each writes its own checkpoint files, so re-running this script resumes.
#
# COSTS MONEY: the recorded run was 5,882 LLM calls / 51.6 M prompt tokens / $3.45,
# and 8 wall-clock hours. Needs OPENROUTER_API_KEY and the Python venv.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "error: OPENROUTER_API_KEY is not set. mem0's write path is LLM-based." >&2
  exit 1
fi

WORK="${LOCOMO_WORK:-$HERE/work}"
PY="${LOCOMO_PY:-$HERE/.venv/bin/python}"
if [ ! -x "$PY" ]; then
  echo "error: python venv not found at $PY" >&2
  echo "       python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt" >&2
  echo "       (or set LOCOMO_PY to an interpreter that has mem0ai installed)" >&2
  exit 1
fi
if [ ! -f "$WORK/corpus.json" ]; then
  echo "error: canonical corpus not found at $WORK/corpus.json. Run ./mode_a.sh first." >&2
  exit 1
fi

# Keep the HuggingFace model cache inside the harness rather than in $HOME.
export HF_HOME="${HF_HOME:-$HERE/hf-cache}"
export TOKENIZERS_PARALLELISM=false
# One process per conversation; cap per-process threads so 10 of them do not
# oversubscribe the machine.
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-2}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-2}"

mkdir -p "$WORK/logs"
SIDS=$(python3 -c 'import json,sys;print(" ".join(c["sample_id"] for c in json.load(open(sys.argv[1]))["conversations"]))' "$WORK/corpus.json")

for sid in $SIDS; do
  if [ -f "$WORK/mem0/$sid.done.json" ]; then echo "skip $sid (done)"; continue; fi
  # mem0 keeps a GLOBAL migration/telemetry qdrant store under $MEM0_DIR (default
  # ~/.mem0). Local qdrant takes an exclusive lock on it, so concurrent processes
  # collide -- and the default path is shared with any other mem0 process on the
  # machine. One MEM0_DIR per process fixes both.
  MEM0_DIR="$WORK/mem0home/$sid" \
  nohup "$PY" run_mem0.py --sid "$sid" --work "$WORK" --depth 30 \
    >> "$WORK/logs/mem0-$sid.log" 2>&1 &
  echo "launched $sid pid=$! MEM0_DIR=$WORK/mem0home/$sid"
  sleep 3
done
echo "--- all launched; tail $WORK/logs/mem0-*.log to follow ---"
