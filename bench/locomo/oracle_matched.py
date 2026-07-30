#!/usr/bin/env python3
"""
The oracle upper bound was run on a deterministic stratified subsample, so comparing
it to full-set system accuracy mixes denominators. This restricts every system to the
EXACT question set the oracle answered, which is the only valid way to read the
"retrieval failure vs answering failure" split.
"""
import json
import os
from collections import defaultdict

from paths import OUT, require_file

ckpt = require_file(os.path.join(OUT, "mode_b.jsonl"), "Mode B checkpoint",
                    "Run run_mode_b.py with --systems including oracle first.")
rows = [json.loads(l) for l in open(ckpt) if l.strip()]
uniq = {}
for r in rows:
    uniq[(r["system"], r["k"], r["qid"])] = r
rows = list(uniq.values())

oracle_qids = {r["qid"] for r in rows if r["system"] == "oracle"}
oracle_answerable = {r["qid"] for r in rows if r["system"] == "oracle" and not r["adversarial"]}
print(f"oracle subsample: {len(oracle_qids)} questions ({len(oracle_answerable)} answerable)\n")

groups = defaultdict(list)
for r in rows:
    groups[(r["system"], r["k"])].append(r)


def acc(sub):
    j = [r for r in sub if r["correct"] is not None]
    return (sum(1 for r in j if r["correct"]) / len(j), len(j)) if j else (None, 0)


print(f"{'system@k':34s} {'full-set':>12s} {'oracle-subset':>15s}  {'n_sub':>6s}  per-category (oracle subset)")
out = []
for (s, k), rs in sorted(groups.items()):
    ans_full = [r for r in rs if not r["adversarial"]]
    ans_sub = [r for r in rs if not r["adversarial"] and r["qid"] in oracle_answerable]
    a_full, _ = acc(ans_full)
    a_sub, n_sub = acc(ans_sub)
    cats = {}
    for c in ("1", "2", "3", "4"):
        v, _ = acc([r for r in ans_sub if r["category"] == c])
        cats[c] = v
    cs = " ".join(f"c{c}={'-' if cats[c] is None else format(cats[c], '.3f')}" for c in ("1", "2", "3", "4"))
    out.append((a_sub if a_sub is not None else -1, s, k, a_full, a_sub, n_sub, cs))

for _, s, k, a_full, a_sub, n_sub, cs in sorted(out, reverse=True):
    fs = "-" if a_full is None else f"{a_full:.3f}"
    ss = "-" if a_sub is None else f"{a_sub:.3f}"
    print(f"{s + '@k=' + str(k):34s} {fs:>12s} {ss:>15s}  {n_sub:>6d}  {cs}")
