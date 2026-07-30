#!/usr/bin/env bash
# LongMemEval Mode B -- QA accuracy with an LLM reader and an LLM judge.
#
#   ./run-modeB.sh                          full 500 at k=10 and k=30 + oracle subsample
#   ./run-modeB.sh --limit=10 --tag=smoke    10-question smoke test
#   CONDITIONS=oracle ./run-modeB.sh         only the oracle upper bound
#   CONCURRENCY=4 ./run-modeB.sh             fewer in-flight requests
#
# COSTS MONEY: the recorded full run was 6.15 M prompt tokens for $0.86 on
# deepseek/deepseek-v4-flash. Needs OPENROUTER_API_KEY in the environment, and
# Mode A results for the retrieval system it reads (default "memory-core").
# Resumable: re-run the same command and finished questions are skipped.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

case "${1:-}" in
  -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "error: OPENROUTER_API_KEY is not set." >&2
  echo "       Mode B calls a reader and a judge model over OpenRouter." >&2
  echo "       Mode A (./run-modeA.sh) needs no key and no network." >&2
  exit 1
fi

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

exec "$NODE" "$TSX" "$HERE/modeB.ts" \
  --conditions="${CONDITIONS:-k10,k30,oracle}" \
  --concurrency="${CONCURRENCY:-8}" "$@"
