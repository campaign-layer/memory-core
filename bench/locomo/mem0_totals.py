import glob
import json
import os

from paths import MEM0_DIR

tw = ts = usd = 0.0
calls = pt = ct = empty = errs = 0
turns = mems = 0
per = []
files = sorted(glob.glob(os.path.join(MEM0_DIR, "*.done.json")))
if not files:
    raise SystemExit(f"no mem0 completion markers under {MEM0_DIR}. Run ./launch_mem0.sh first.")
for f in files:
    d = json.load(open(f))
    m = d["total_meter"]
    tw += d["ingest_seconds"]
    ts += d["search_seconds"]
    usd += m["usd_cost"]
    calls += m["llm_calls"]
    pt += m["prompt_tokens"]
    ct += m["completion_tokens"]
    empty += m.get("empty_content_responses", 0)
    errs += m.get("llm_errors", 0)
    turns += d["turns_ingested"]
    mems += d["memories_surviving"]
    per.append((d["sample_id"], d["turns_ingested"], d["memories_surviving"],
                d["ingest_seconds"], d["search_seconds"], m["usd_cost"]))

for sid, t, mm, ing, se, c in per:
    print(f"  {sid}: {t:4d} turns -> {mm:4d} memories  ingest={ing:7.0f}s search={se:6.1f}s  ${c:.3f}")
print(f"\nTOTAL: {turns} turns -> {mems} memories ({100*mems/turns:.1f}% of turns survive as a memory)")
print(f"  summed per-conversation ingest time = {tw:.0f}s ({tw/3600:.2f} h of process time)")
print(f"  wall-clock (10 processes in parallel) = max single conversation = {max(p[3] for p in per):.0f}s "
      f"({max(p[3] for p in per)/3600:.2f} h)")
print(f"  search total = {ts:.1f}s for 1986 queries")
print(f"  llm_calls={calls}  prompt_tokens={pt:,}  completion_tokens={ct:,}")
print(f"  empty_content_responses={empty}  llm_errors={errs}")
print(f"  USD (OpenRouter reported) = ${usd:.4f}")
print(f"  per add: {calls/turns:.2f} llm calls, {pt/turns:,.0f} prompt tok, ${usd/turns:.6f}")
