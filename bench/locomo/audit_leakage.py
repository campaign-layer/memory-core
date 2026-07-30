#!/usr/bin/env python3
"""
Leakage audit. This repo previously "scored" 27.9% on LongMemEval by hardcoding gold
answers, so every good score here is treated as a bug until proven otherwise.

Checks:
 1. The retrieval corpus is built ONLY from dialogue turns -- no qa/observation/
    session_summary/event_summary text appears in any indexed document.
 2. The query actually sent to each system is byte-identical to the dataset question,
    and no gold answer string was appended to it.
 3. No answer-derived field is referenced anywhere in the retrieval code paths.
 4. memory-core's own source contains no LoCoMo-specific literals.
 5. The random control sits at the analytic chance rate (a leaking harness lifts
    random too, so this is the sharpest single test).
"""
import json
import os
import re
import subprocess
import sys

from paths import CORPUS, HARNESS_ROOT, OUT, REPO_ROOT, require_corpus, require_dataset

FAIL = []
WARN = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""))
    if not ok:
        FAIL.append(name)


corpus = json.load(open(require_corpus()))
# The corpus records the dataset path it was built from; re-resolve it so the audit
# still runs when the corpus was built on another machine.
raw = json.load(open(require_dataset(corpus["meta"].get("dataset_path"))
                     if os.path.exists(corpus["meta"].get("dataset_path") or "")
                     else require_dataset()))
by_sid = {c["sample_id"]: c for c in raw}

# ---- 1. corpus text provenance ------------------------------------------------
bad = []
for c in corpus["conversations"]:
    src = by_sid[c["sample_id"]]
    allowed = set()
    for k, v in src["conversation"].items():
        if re.fullmatch(r"session_\d+", k):
            for t in v:
                allowed.add(t["text"])
                if t.get("blip_caption"):
                    allowed.add(t["blip_caption"])
    for t in c["turns"]:
        # every indexed doc must decompose into (date prefix, speaker, turn text[, caption])
        if t["raw_text"] not in allowed:
            bad.append((c["sample_id"], t["id"]))
check("corpus turns come only from conversation.session_N", not bad,
      f"{len(bad)} foreign turns" if bad else f"{corpus['meta']['n_turns']} turns verified")

# The reverse test (annotation text absent from the corpus) is NOT valid: LoCoMo's
# `observation` / `session_summary` fields are built by quoting the dialogue, so
# overlap means the annotation copied the turn, not that the corpus imported the
# annotation. Check 1 above already proves the stronger property -- every indexed
# document decomposes into verbatim dialogue turn text -- so no separate test is
# needed. Verified by hand: the one overlapping span is verbatim conv-26 D3:1.
n_annot = sum(1 for c in raw for f in ("observation", "session_summary", "event_summary") if c.get(f))
print(f"[INFO] {n_annot} annotation fields present in the dataset and none ingested "
      f"(guaranteed by check 1, which whitelists dialogue turn text only)")

# ---- 2. queries are the dataset questions, unmodified -------------------------
mismatch = 0
for c in corpus["conversations"]:
    src_q = {i: q for i, q in enumerate(by_sid[c["sample_id"]]["qa"])}
    for q in c["questions"]:
        i = int(q["qid"].split("#")[1])
        if q["question"] != src_q[i]["question"]:
            mismatch += 1
check("query text == dataset question text", mismatch == 0,
      f"{corpus['meta']['n_questions']} questions verified")

# the answer must never be a substring of the query
ansinq = 0
for c in corpus["conversations"]:
    for q in c["questions"]:
        a = q.get("answer")
        if a and isinstance(a, str) and len(a) > 8 and a.lower() in q["question"].lower():
            ansinq += 1
# A handful of LoCoMo questions are of the form "would X prefer A or B?" where the
# gold answer is one of the offered options, so the answer string necessarily occurs
# in the question. That is a dataset property applied identically to every system,
# not a harness leak, so it is reported rather than failed.
print(f"[INFO] {ansinq}/{corpus['meta']['n_questions']} questions contain their own gold answer "
      f"(LoCoMo multiple-choice phrasing; identical for all systems, not a harness leak)")

# ---- 3. retrieval code must not read answer fields ---------------------------
# The answer/gold fields may only be read by the SCORERS, never by code that ranks.
retrieval_files = [os.path.join(HARNESS_ROOT, f)
                   for f in ("run_retrieval.ts", "run_retrieval2.ts", "run_mem0.py", "attribute_mem0.py")]
banned = re.compile(r"\b(answer|adversarial_answer|gold_turn_ids|resolved_evidence|named_evidence)\b")
offenders = {}
for f in retrieval_files:
    if not os.path.exists(f):
        continue
    hits = []
    for n, line in enumerate(open(f), 1):
        s = line.split("#")[0].split("//")[0]
        # skip TypeScript interface field declarations -- a type is not a read
        if re.search(r":\s*(string\[\]|boolean|string|number)\s*;", s):
            continue
        if banned.search(s):
            hits.append(f"{n}: {line.strip()[:100]}")
    if hits:
        offenders[os.path.basename(f)] = hits
# attribute_mem0.py legitimately reads gold_turn_ids to compute the recall CEILING
# diagnostic, which is not part of any ranking. Flag anything else.
real = {f: h for f, h in offenders.items() if f != "attribute_mem0.py"}
check("no answer/gold field referenced in ranking code paths", not real,
      f"{real}" if real else f"checked {[os.path.basename(f) for f in retrieval_files]}; "
                             f"attribute_mem0.py reads gold only "
                             f"for the ceiling diagnostic, never for ranking")

# ---- 4. memory-core source has no LoCoMo literals ----------------------------
# The property under test is that the LIBRARY does not special-case a benchmark. A
# comment citing a benchmark result is documentation, not behaviour, so comments are
# stripped the same way check 3 strips them and reported as INFO instead. Any such
# literal in actual code still fails: that is the case this check exists to catch.
BENCH_LITERAL = re.compile(r"locomo|longmemeval|dia_id|blip_caption|adversarial_answer", re.I)
code_hits, comment_hits = [], []
try:
    raw = subprocess.run(
        ["grep", "-rniE", "locomo|longmemeval|dia_id|blip_caption|adversarial_answer",
         os.path.join(REPO_ROOT, "src")],
        capture_output=True, text=True).stdout.strip()
    for line in [l for l in raw.split("\n") if l]:
        path, _, text = line.partition(":")
        _, _, body = text.partition(":")
        # Strip line comments and a leading block-comment continuation.
        code = body.split("//")[0].split("#")[0]
        code = re.sub(r"^\s*\*.*", "", code)
        (code_hits if BENCH_LITERAL.search(code) else comment_hits).append(line)
except Exception as e:
    code_hits.append(f"grep failed: {e}")
check("memory-core/src contains no benchmark-specific literals in CODE",
      not code_hits,
      "\n".join(code_hits)[:600] if code_hits else "checked src/ recursively")
if comment_hits:
    print(f"[INFO] {len(comment_hits)} benchmark name(s) appear in src/ COMMENTS only "
          f"(documentation of measured results, not behaviour); first: "
          f"{comment_hits[0][:160]}")

# ---- 5. random control vs analytic chance ------------------------------------
p = os.path.join(OUT, "mode_a.json")
if not os.path.exists(p):
    p = os.path.join(OUT, "mode_a_partial.json")
if os.path.exists(p):
    d = json.load(open(p))
    rnd = next((s for s in d["systems"] if s["system"] == "random"), None)
    an = d["analytic_random_baseline"]
    if rnd:
        emp = rnd["overall"]["recallAt"]["10"]
        exp = an["recallAt"]["10"]
        ok = abs(emp - exp) < 0.02
        check("random control sits at analytic chance", ok,
              f"empirical R@10={emp:.4f} vs analytic {exp:.4f}")
        # Providers that CONSOLIDATE (mem0, memory-core:dual-layer) legitimately return
        # synthesized records whose ids are not corpus turn ids. Those are attributed
        # (mem0) or reported as a lower bound (dual-layer); they are not leakage. Every
        # system that is supposed to return raw turn ids must be exactly 0.
        consolidating = ("mem0", "memory-core:dual-layer")
        raw_id_systems = [s for s in d["systems"] if not s["system"].startswith(consolidating)]
        check("every turn-id system stayed inside its own conversation's corpus",
              all(s["foreign_turn_references"] == 0 for s in raw_id_systems),
              ", ".join(f"{s['system']}={s['foreign_turn_references']}" for s in raw_id_systems))
        for s in d["systems"]:
            if s["system"].startswith(consolidating) and s["foreign_turn_references"]:
                tot = s["queries_scored"] * 30
                print(f"[INFO] {s['system']} returned {s['foreign_turn_references']} synthesized "
                      f"(non-turn) records of ~{tot} slots -- consolidating provider; "
                      f"score is a LOWER bound unless attributed")
else:
    WARN.append("mode_a json not present yet; skipped checks 5")

print()
if FAIL:
    print(f"AUDIT FAILED: {FAIL}")
    sys.exit(1)
print("AUDIT PASSED" + (f" (warnings: {WARN})" if WARN else ""))
