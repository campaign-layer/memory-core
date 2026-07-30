import json
import os

from paths import RANKINGS, WORK, require_file


def load(p):
    d = {}
    for line in open(p):
        if line.strip():
            r = json.loads(line)
            d[r["qid"]] = [it.get("turn_ids") for it in r["items"]]
    return d


HOW = "Run attribute_mem0.py first; it writes all three attribution channels."
a = load(require_file(os.path.join(RANKINGS, "mem0.jsonl"), "mem0 event-log rankings", HOW))
b = load(require_file(os.path.join(RANKINGS, "mem0-metadata.jsonl"), "mem0 metadata rankings", HOW))
c = load(require_file(os.path.join(RANKINGS, "mem0-textmatch.jsonl"), "mem0 textmatch rankings", HOW))

same_ab = sum(1 for k in a if a[k] == b.get(k))
same_ac = sum(1 for k in a if a[k] == c.get(k))
print(f"queries: {len(a)}")
print(f"event-log == metadata           : {same_ab}/{len(a)} ({100*same_ab/len(a):.2f}%)")
print(f"event-log == textmatch          : {same_ac}/{len(a)} ({100*same_ac/len(a):.2f}%)")

# slot-level comparison
tot = ev_empty = md_empty = tm_extra = 0
for k in a:
    for i, slot in enumerate(a[k]):
        tot += 1
        if not slot:
            ev_empty += 1
        mdslot = b[k][i] if k in b and i < len(b[k]) else None
        if not mdslot:
            md_empty += 1
        tmslot = c[k][i] if k in c and i < len(c[k]) else None
        if tmslot and slot and len(tmslot) > len(slot):
            tm_extra += 1
print(f"\nretrieved slots: {tot}")
print(f"  slots with NO event-log attribution (count as a consumed miss): {ev_empty} ({100*ev_empty/tot:.3f}%)")
print(f"  slots with NO metadata attribution                            : {md_empty} ({100*md_empty/tot:.3f}%)")
print(f"  slots where textmatch added extra turn ids                    : {tm_extra} ({100*tm_extra/tot:.2f}%)")

rep = json.load(open(require_file(os.path.join(WORK, "mem0_attribution_report.json"),
                                 "mem0 attribution report", HOW)))
print(f"\nevent_counts: {rep['event_counts']}")
print(f"fanout: {rep['fanout']}")
print(f"recall ceiling: {json.dumps(rep['recall_ceiling_from_surviving_memories'], indent=1)}")
