#!/usr/bin/env python3
"""
Maps retrieved mem0 memories back onto LoCoMo gold turn ids.

This is the crux of a fair comparison: mem0 rewrites and consolidates, so a
retrieved memory is not a corpus turn. Three attribution channels are produced so
the answer is bracketed rather than asserted:

  mem0            (PRIMARY, exact)  event-log provenance. Replaying every add()'s
                  returned events gives, for each memory id, the exact set of turns
                  whose ingestion created (ADD) or modified (UPDATE) it. This is
                  mem0's own bookkeeping, so it is neither generous nor stingy.

  mem0-metadata   (LOWER bound) only the turn named in the memory's metadata, i.e.
                  the turn that first created it. Biased AGAINST mem0: when a later
                  turn UPDATEs a memory, that later turn is not credited.

  mem0-textmatch  (UPPER bound) event-log provenance UNION lexical containment of
                  the memory text in a turn's text. Biased FOR mem0: a memory can
                  resemble a turn it never came from.

Every channel is QUERY-INDEPENDENT -- attribution never looks at the question or the
gold answer, so no answer text can leak into the ranking signal. Asserted below.
"""
import argparse
import glob
import json
import os
import re
import statistics
from collections import Counter, defaultdict

from paths import CORPUS, MEM0_DIR, RANKINGS, WORK, require_corpus

STOP = set("""a an the is are was were be been being am of to in on at for with and or i my me you your
he she it its his her they them their that this these those as by from but if then than so not no do does
did have has had will would can could should there here what when where who how why into about over under
up down out off again also just very too any all some such own same said says say also im ive dont
""".split())

# Tokens contributed by the shared "[<date>] <Speaker>:" prefix that every turn text
# carries. They are not evidence of provenance, so they are excluded from containment.
PREFIX_NOISE = set("""am pm on january february march april may june july august september october november
december monday tuesday wednesday thursday friday saturday sunday""".split())


def toks(s):
    out = []
    for t in re.findall(r"[a-z0-9]+", str(s).lower()):
        if len(t) < 2 or t in STOP or t in PREFIX_NOISE:
            continue
        if t.isdigit() and len(t) == 4:  # bare years, from the date prefix
            continue
        out.append(t)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--mem0-dir", default=MEM0_DIR)
    ap.add_argument("--out", default=RANKINGS)
    ap.add_argument("--containment", type=float, default=0.5)
    ap.add_argument("--max-textmatch", type=int, default=3)
    args = ap.parse_args()

    require_corpus(args.corpus)
    corpus = json.load(open(args.corpus))
    convs = {c["sample_id"]: c for c in corpus["conversations"]}

    os.makedirs(args.out, exist_ok=True)
    channels = {"mem0": [], "mem0-metadata": [], "mem0-textmatch": []}

    report = {
        "conversations": {},
        "event_counts": Counter(),
        "totals": Counter(),
        "containment_threshold": args.containment,
    }
    ceiling_rows = []
    fanout_samples = defaultdict(list)
    cost = Counter()
    wall = {"ingest_seconds": 0.0, "search_seconds": 0.0, "per_conv_ingest_seconds": {}}
    done_files = sorted(glob.glob(os.path.join(args.mem0_dir, "*.done.json")))

    for done_path in done_files:
        sid = os.path.basename(done_path)[: -len(".done.json")]
        conv = convs.get(sid)
        if conv is None:
            continue
        done = json.load(open(done_path))
        for k in ("llm_calls", "prompt_tokens", "completion_tokens", "llm_errors"):
            cost[k] += done["total_meter"][k]
        cost["usd"] += done["total_meter"]["usd_cost"]
        wall["ingest_seconds"] += done["ingest_seconds"]
        wall["search_seconds"] += done["search_seconds"]
        wall["per_conv_ingest_seconds"][sid] = done["ingest_seconds"]

        turns = {t["id"]: t for t in conv["turns"]}
        turn_tok = {tid: set(toks(t["raw_text"] + " " + t.get("caption", ""))) for tid, t in turns.items()}

        # ---- channel 1+2: replay the event log for exact provenance ---------------
        prov = defaultdict(set)      # memory_id -> {turn_id, ...}  (ADD or UPDATE)
        created_by = {}              # memory_id -> turn_id that ADDed it
        deleted = set()
        n_add = n_upd = n_del = n_noop = 0
        adds_path = os.path.join(args.mem0_dir, f"{sid}.adds.jsonl")
        turns_with_events = set()
        for line in open(adds_path):
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            tid = row["turn_id"]
            if not row.get("events"):
                n_noop += 1
                continue
            turns_with_events.add(tid)
            for e in row["events"]:
                mid, ev = e.get("id"), (e.get("event") or "").upper()
                if not mid:
                    continue
                report["event_counts"][ev] += 1
                if ev == "ADD":
                    n_add += 1
                    created_by[mid] = tid
                    prov[mid].add(tid)
                elif ev == "UPDATE":
                    n_upd += 1
                    prov[mid].add(tid)
                elif ev == "DELETE":
                    n_del += 1
                    deleted.add(mid)

        # ---- channel 3: query-independent lexical containment ---------------------
        mems = json.load(open(os.path.join(args.mem0_dir, f"{sid}.memories.json")))
        text_match = {}
        for m in mems:
            mid = m.get("id")
            mt = set(toks(m.get("memory") or ""))
            if not mt:
                text_match[mid] = []
                continue
            scored = []
            for tid, tt in turn_tok.items():
                if not tt:
                    continue
                c = len(mt & tt) / len(mt)
                if c >= args.containment:
                    scored.append((c, tid))
            scored.sort(reverse=True)
            text_match[mid] = [tid for _, tid in scored[: args.max_textmatch]]

        meta_turn = {m.get("id"): (m.get("metadata") or {}).get("turn_id") for m in mems}

        # ---- recall ceiling: gold turns that ANY surviving memory traces to -------
        surviving = {m.get("id") for m in mems}
        covered = set()
        for mid in surviving:
            covered |= prov.get(mid, set())
        for q in conv["questions"]:
            if not q["gold_turn_ids"]:
                continue
            hit = sum(1 for g in q["gold_turn_ids"] if g in covered)
            ceiling_rows.append({"qid": q["qid"], "category": q["category"],
                                 "ceiling": hit / len(q["gold_turn_ids"])})

        # ---- build the three ranking files ---------------------------------------
        search_path = os.path.join(args.mem0_dir, f"{sid}.search.jsonl")
        for line in open(search_path):
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            qid = r["qid"]
            rows = {k: [] for k in channels}
            for h in r.get("hits") or []:
                mid = h.get("id")
                score = h.get("score")
                exact = sorted(prov.get(mid, set()))
                md = meta_turn.get(mid) or ((h.get("metadata") or {}).get("turn_id"))
                md_list = [md] if md and md in turns else []
                gen = list(dict.fromkeys(exact + [t for t in text_match.get(mid, []) if t in turns]))
                rows["mem0"].append({"turn_ids": exact, "score": score, "mem_id": mid})
                rows["mem0-metadata"].append({"turn_ids": md_list, "score": score, "mem_id": mid})
                rows["mem0-textmatch"].append({"turn_ids": gen, "score": score, "mem_id": mid})
                fanout_samples["mem0"].append(len(exact))
                fanout_samples["mem0-textmatch"].append(len(gen))
                report["totals"]["retrieved_items"] += 1
                if not exact:
                    report["totals"]["items_unattributed_exact"] += 1
            for k in channels:
                channels[k].append({"system": k, "sample_id": sid, "qid": qid,
                                    "latency_ms": r.get("latency_ms"), "items": rows[k]})

        report["conversations"][sid] = {
            "turns_ingested": done["turns_ingested"],
            "memories_surviving": len(mems),
            "adds_producing_no_memory_noop": n_noop,
            "events": {"ADD": n_add, "UPDATE": n_upd, "DELETE": n_del},
            "turns_with_at_least_one_event": len(turns_with_events),
            "turn_retention_rate": round(len(turns_with_events) / max(1, done["turns_ingested"]), 4),
            "ingest_seconds": done["ingest_seconds"],
            "usd_cost": done["total_meter"]["usd_cost"],
        }

    for k, rows in channels.items():
        p = os.path.join(args.out, f"{k.replace(':', '_')}.jsonl")
        with open(p, "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        n_conv = len(report["conversations"])
        meta = {
            "system": k,
            "note": {
                "mem0": "mem0 OSS 2.0.14, attribution = exact event-log provenance (ADD+UPDATE turns)",
                "mem0-metadata": "mem0 OSS 2.0.14, attribution = creating turn only (LOWER bound)",
                "mem0-textmatch": "mem0 OSS 2.0.14, attribution = event-log UNION lexical containment >= "
                                  f"{args.containment} (UPPER bound)",
            }[k],
            "depth": 30,
            "conversations": n_conv,
            "queries": len(rows),
            "llm_calls": cost["llm_calls"],
            "prompt_tokens": cost["prompt_tokens"],
            "completion_tokens": cost["completion_tokens"],
            "usd_cost": round(cost["usd"], 4),
            "ingest_seconds": round(wall["ingest_seconds"], 1),
            "search_seconds": round(wall["search_seconds"], 1),
            "mean_attributed_turns_per_retrieved_item":
                round(statistics.mean(fanout_samples[k]), 3) if fanout_samples.get(k) else None,
        }
        with open(os.path.join(args.out, f"{k.replace(':', '_')}.meta.json"), "w") as f:
            json.dump(meta, f, indent=2)

    by_cat = defaultdict(list)
    for r in ceiling_rows:
        by_cat[r["category"]].append(r["ceiling"])
    report["recall_ceiling_from_surviving_memories"] = {
        "overall": round(statistics.mean([r["ceiling"] for r in ceiling_rows]), 4) if ceiling_rows else None,
        "per_category": {k: round(statistics.mean(v), 4) for k, v in sorted(by_cat.items())},
        "n": len(ceiling_rows),
    }
    report["event_counts"] = dict(report["event_counts"])
    report["totals"] = dict(report["totals"])
    report["cost"] = {**{k: v for k, v in cost.items() if k != "usd"}, "usd_cost": round(cost["usd"], 4)}
    report["wall_clock"] = wall
    report["fanout"] = {k: round(statistics.mean(v), 3) for k, v in fanout_samples.items() if v}

    report_path = os.path.join(WORK, "mem0_attribution_report.json")
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in
                      ["event_counts", "totals", "recall_ceiling_from_surviving_memories", "cost", "fanout"]},
                     indent=2))
    print(f"\nconversations attributed: {len(report['conversations'])}")
    for sid, v in sorted(report["conversations"].items()):
        print(f"  {sid}: {v['turns_ingested']} turns -> {v['memories_surviving']} memories "
              f"(retention {v['turn_retention_rate']:.2f}) events={v['events']} "
              f"{v['ingest_seconds']:.0f}s ${v['usd_cost']:.3f}")


if __name__ == "__main__":
    main()
