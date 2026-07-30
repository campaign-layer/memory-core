#!/usr/bin/env python3
"""
Mode B scorer: QA accuracy per category and overall, per (system, k), plus the
oracle-context upper bound and the adversarial abstention rate.

Categories 1-4 are answerable and scored as accuracy. Category 5 is adversarial:
`answer` is null and the correct behaviour is to decline, so it is reported
separately as an abstention rate and never mixed into the answerable accuracy.
"""
import argparse
import glob
import json
import os
import re
import subprocess
from collections import Counter, defaultdict

from paths import CORPUS, LOGS, OUT, REPO_ROOT, require_corpus, require_file


def refusal(pred):
    if not pred:
        return True
    p = pred.strip().lower().rstrip(".!")
    return p in ("i don't know", "i dont know", "unknown", "i do not know") or "don't know" in p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=os.path.join(OUT, "mode_b.jsonl"))
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--logs", default=os.path.join(LOGS, "mode_b.log"))
    ap.add_argument("--out", default=os.path.join(OUT, "mode_b.json"))
    args = ap.parse_args()

    require_corpus(args.corpus)
    require_file(args.checkpoint, "Mode B checkpoint",
                 "Run run_mode_b.py first (it writes this file as it goes).")
    corpus = json.load(open(args.corpus))
    labels = corpus["meta"]["category_labels"]

    rows = []
    for line in open(args.checkpoint):
        if line.strip():
            rows.append(json.loads(line))

    # de-dup: last write per (system,k,qid) wins
    uniq = {}
    for r in rows:
        uniq[(r["system"], r["k"], r["qid"])] = r
    rows = list(uniq.values())

    groups = defaultdict(list)
    for r in rows:
        groups[(r["system"], r["k"])].append(r)

    results = {}
    for (system, k), rs in sorted(groups.items()):
        ans = [r for r in rs if not r["adversarial"]]
        adv = [r for r in rs if r["adversarial"]]

        def acc(sub):
            judged = [r for r in sub if r["correct"] is not None]
            if not judged:
                return {"n": len(sub), "judged": 0, "correct": 0, "accuracy": None}
            c = sum(1 for r in judged if r["correct"])
            return {"n": len(sub), "judged": len(judged), "correct": c,
                    "accuracy": round(c / len(judged), 4)}

        per_cat = {}
        for cat in sorted({r["category"] for r in rs}):
            sub = [r for r in rs if r["category"] == cat]
            per_cat[cat] = {**acc(sub), "label": labels.get(cat, cat)}

        results[f"{system}@k={k}"] = {
            "system": system,
            "k": k,
            "overall_answerable_cat1_4": acc(ans),
            "adversarial_cat5_abstention": acc(adv),
            "per_category": per_cat,
            "refusal_rate_on_answerable": round(
                sum(1 for r in ans if refusal(r["prediction"])) / len(ans), 4) if ans else None,
            "mean_context_items": round(sum(r["n_context"] for r in rs) / len(rs), 2) if rs else None,
            "empty_context_questions": sum(1 for r in rs if r["n_context"] == 0),
            "unjudged": sum(1 for r in rs if r["correct"] is None),
            "answer_errors": sum(1 for r in rs if r.get("answer_error")),
        }

    # cost: sum the final meter line of every invocation recorded in the log
    meter = Counter()
    if os.path.exists(args.logs):
        for m in re.finditer(r"meter=(\{.*?\})\s*$", open(args.logs).read(), re.M):
            try:
                d = json.loads(m.group(1))
                for kk, vv in d.items():
                    if isinstance(vv, (int, float)):
                        meter[kk] += vv
            except Exception:
                pass

    sha = "unknown"
    try:
        sha = subprocess.check_output(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        pass

    report = {
        "mode": "B (QA accuracy, LLM judge)",
        "provenance": {
            "memory_core_git_sha": sha,
            "dataset_sha256": corpus["meta"]["dataset_sha256"],
            "corpus_sha256": corpus["meta"]["corpus_sha256"],
            "query_sha256": corpus["meta"]["query_sha256"],
            "answerer_model": "deepseek/deepseek-v4-flash (reasoning disabled)",
            "judge_model": "deepseek/deepseek-v4-flash (reasoning disabled)",
            "command": f"python run_mode_b.py --systems=... --ks=10,30 --checkpoint={args.checkpoint}"
                       f" && python score_mode_b.py --checkpoint={args.checkpoint}",
        },
        "notes": {
            "context_unit": "each system's NATIVE retrieved unit: dialogue turns for "
                            "memory-core/bm25/random, mem0's own consolidated memory texts for mem0",
            "oracle": "k=0 row; context is the gold evidence turns, giving the answering "
                      "upper bound that separates retrieval failure from answering failure",
            "cat5": "adversarial/unanswerable; scored as abstention (CORRECT = declines), "
                    "never mixed into answerable accuracy",
        },
        "llm_usage": dict(meter),
        "results": results,
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    json.dump(report, open(args.out, "w"), indent=2)

    cats = sorted({c for v in results.values() for c in v["per_category"]})
    print(f"\n=== MODE B: accuracy ===")
    hdr = "system@k".ljust(34) + "overall(1-4)  " + "  ".join(f"cat{c}".ljust(7) for c in cats) + " cat5-abstain  refusal"
    print(hdr)
    def cell(x, w=7):
        return ("-" if x is None else format(x, ".3f")).ljust(w)

    for name, v in sorted(results.items(), key=lambda x: (x[1]["system"], x[1]["k"])):
        o = v["overall_answerable_cat1_4"]
        cells = "  ".join(cell(v["per_category"].get(c, {}).get("accuracy")) for c in cats)
        a5 = v["adversarial_cat5_abstention"]["accuracy"]
        ref = v["refusal_rate_on_answerable"]
        print(name.ljust(34) + cell(o["accuracy"], 14) + cells + " " + cell(a5, 13)
              + ("-" if ref is None else format(ref, ".3f")))

    print("\n=== n judged per system@k ===")
    for name, v in sorted(results.items()):
        print(f"  {name.ljust(34)} answerable n={v['overall_answerable_cat1_4']['n']} "
              f"judged={v['overall_answerable_cat1_4']['judged']} | adv n={v['adversarial_cat5_abstention']['n']} "
              f"| unjudged={v['unjudged']} empty_ctx={v['empty_context_questions']}")
    print(f"\nllm usage: {json.dumps(dict(meter))}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
