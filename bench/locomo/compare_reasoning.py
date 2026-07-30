#!/usr/bin/env python3
"""
Sensitivity check: does disabling the model's reasoning mode change what mem0 stores?

Compares the two mem0 ingests on the SAME conversations over the SAME turn prefix:
  --off <dir>/mem0   reasoning DISABLED (the primary full run; default work/)
  --on  <dir>/mem0   reasoning ENABLED  (mem0's out-of-the-box behaviour)

Reports extraction rate, gold-turn coverage ceiling, date anchoring and cost, so the
one configuration choice that could move mem0's ceiling is quantified rather than
assumed.
"""
import argparse
import glob
import json
import os
import re
from collections import defaultdict

from paths import CORPUS, WORK, require_corpus

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("--corpus", default=CORPUS)
ap.add_argument("--off", default=WORK, help="work dir of the reasoning-DISABLED run")
ap.add_argument("--on", default=WORK + "_reasonon",
                help="work dir of the reasoning-ENABLED sensitivity run "
                     "(produced by MEM0_REASONING=on run_mem0.py --work <dir>)")
args = ap.parse_args()

corpus = json.load(open(require_corpus(args.corpus)))
convs = {c["sample_id"]: c for c in corpus["conversations"]}


def load(root, sid, limit):
    p = os.path.join(root, "mem0", f"{sid}.adds.jsonl")
    if not os.path.exists(p):
        return None
    rows = [json.loads(l) for l in open(p) if l.strip()]
    return rows[:limit]


def analyse(rows, conv):
    prov = defaultdict(set)
    n_noop = n_add = n_upd = 0
    y2026 = n_mem = 0
    ptok = ctok = 0
    secs = 0.0
    for r in rows:
        ptok += r["prompt_tokens"]
        ctok += r["completion_tokens"]
        secs += r["seconds"]
        if not r["events"]:
            n_noop += 1
            continue
        for e in r["events"]:
            ev = (e.get("event") or "").upper()
            if ev == "ADD":
                n_add += 1
            elif ev == "UPDATE":
                n_upd += 1
            if e.get("id"):
                prov[e["id"]].add(r["turn_id"])
            m = str(e.get("memory") or "")
            if m:
                n_mem += 1
                if re.search(r"\b(2025|2026)\b", m):
                    y2026 += 1
    covered = set()
    for v in prov.values():
        covered |= v
    ingested = {r["turn_id"] for r in rows}
    # gold-turn coverage ceiling, restricted to gold that lies inside the ingested prefix
    tot = hit = 0
    for q in conv["questions"]:
        for g in q["gold_turn_ids"]:
            if g in ingested:
                tot += 1
                hit += 1 if g in covered else 0
    return {
        "adds": len(rows),
        "noop_adds": n_noop,
        "noop_rate": round(n_noop / max(1, len(rows)), 3),
        "ADD": n_add, "UPDATE": n_upd,
        "turns_covered": len(covered),
        "turn_coverage": round(len(covered) / max(1, len(rows)), 3),
        "gold_in_prefix": tot,
        "gold_covered": hit,
        "gold_coverage_ceiling": round(hit / max(1, tot), 3),
        "memories_with_2025_2026_date": y2026,
        "memories_total": n_mem,
        "wrong_year_rate": round(y2026 / max(1, n_mem), 3),
        "prompt_tokens": ptok, "completion_tokens": ctok,
        "mean_completion_tokens": round(ctok / max(1, len(rows)), 1),
        "mean_seconds_per_add": round(secs / max(1, len(rows)), 2),
    }


sids = sorted({os.path.basename(p).replace(".adds.jsonl", "")
               for p in glob.glob(os.path.join(args.on, "mem0", "*.adds.jsonl"))})
if not sids:
    raise SystemExit(
        f"no reasoning-ENABLED run found under {args.on}/mem0/.\n"
        f"Produce one with:  MEM0_REASONING=on python3 run_mem0.py --sid <id> --work {args.on}")
print("mem0 reasoning sensitivity (matched conversations, matched turn prefix)\n")
for sid in sids:
    on = load(args.on, sid, 10 ** 9)
    if not on:
        continue
    n = len(on)
    off = load(args.off, sid, n)
    if not off or len(off) < n:
        print(f"{sid}: reasoning-ON has {n} adds but reasoning-OFF only has "
              f"{len(off) if off else 0}; skipping until the primary run catches up")
        continue
    a_on, a_off = analyse(on, convs[sid]), analyse(off, convs[sid])
    print(f"=== {sid} (first {n} turns of {len(convs[sid]['turns'])}) ===")
    keys = ["noop_rate", "ADD", "UPDATE", "turn_coverage", "gold_in_prefix",
            "gold_coverage_ceiling", "wrong_year_rate", "mean_completion_tokens",
            "mean_seconds_per_add"]
    print(f"  {'metric':32s} {'reasoning=OFF':>14s} {'reasoning=ON':>14s}")
    for k in keys:
        print(f"  {k:32s} {str(a_off[k]):>14s} {str(a_on[k]):>14s}")
    print()
