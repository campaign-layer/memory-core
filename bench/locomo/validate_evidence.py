import json, ast, re, collections

from paths import require_dataset

P = require_dataset()
data = json.load(open(P))

def as_list(ev):
    if isinstance(ev, list): return [str(x) for x in ev]
    if isinstance(ev, str):
        try:
            v = ast.literal_eval(ev)
            return [str(x) for x in (v if isinstance(v,(list,tuple)) else [v])]
        except Exception:
            return [ev]
    return []

STOP=set("a an the is are was were be been of to in on at for with and or i my me you your he she it its his her they them their that this what when where who how did do does had has have as by from".split())
def toks(s): return [t for t in re.findall(r"[a-z0-9]+", str(s).lower()) if t not in STOP and len(t)>1]

tot=0; unresolved=0; idx_mismatch=0; idx_checked=0
cov=collections.defaultdict(list)
sess_span=[]
for c in data:
    cv=c["conversation"]
    sks=sorted([k for k in cv if re.fullmatch(r"session_\d+",k)], key=lambda s:int(s.split('_')[1]))
    byid={}
    for k in sks:
        n=int(k.split('_')[1])
        for i,t in enumerate(cv[k]):
            byid[t["dia_id"]]=t
            # convention check: dia_id == D<session>:<1-based index>
            idx_checked+=1
            if t["dia_id"] != f"D{n}:{i+1}": idx_mismatch+=1
    dts=[cv.get(f"{k}_date_time") for k in sks]
    sess_span.append((c["sample_id"], dts[0], dts[-1]))
    for q in c["qa"]:
        ev=as_list(q.get("evidence"))
        tot+=len(ev)
        cat=str(q["category"])
        miss=[e for e in ev if e not in byid]
        unresolved+=len(miss)
        ans=q.get("answer")
        if ans is None or cat=="5": continue
        at=set(toks(ans))
        if not at: continue
        et=set()
        for e in ev:
            t=byid.get(e)
            if t:
                et |= set(toks(t["text"]))
                if t.get("blip_caption"): et |= set(toks(t["blip_caption"]))
        cov[cat].append(len(at & et)/len(at))

print("evidence ids total:", tot, "unresolved:", unresolved)
print("dia_id == D<session>:<1-based idx> ?  checked:", idx_checked, "mismatches:", idx_mismatch)
print("\nanswer-token coverage by resolved evidence turn text (validates the id->turn mapping):")
for cat in sorted(cov):
    v=cov[cat]; v.sort()
    import statistics
    print(f"  cat {cat}: n={len(v)} mean={statistics.mean(v):.3f} median={statistics.median(v):.3f} frac>=0.5={sum(1 for x in v if x>=0.5)/len(v):.3f} frac==0={sum(1 for x in v if x==0)/len(v):.3f}")

print("\nsession date spans:")
for s in sess_span: print("  ", s)

# leakage guard: confirm annotation fields exist and are NOT part of conversation
print("\nannotation fields present (MUST NOT be ingested):", [k for k in data[0] if k not in ("conversation","qa","sample_id")])
print("observation type:", type(data[0]["observation"]).__name__, "| session_summary type:", type(data[0]["session_summary"]).__name__)

# multimodal coverage of evidence turns
ev_with_cap=0; ev_total=0
for c in data:
    cv=c["conversation"]; byid={}
    for k in cv:
        if re.fullmatch(r"session_\d+",k):
            for t in cv[k]: byid[t["dia_id"]]=t
    for q in c["qa"]:
        for e in as_list(q.get("evidence")):
            t=byid.get(e)
            if t:
                ev_total+=1
                if t.get("blip_caption"): ev_with_cap+=1
print(f"\nevidence turns with blip_caption: {ev_with_cap}/{ev_total} = {ev_with_cap/ev_total:.3f}")
