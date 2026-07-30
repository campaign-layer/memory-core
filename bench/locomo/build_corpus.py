#!/usr/bin/env python3
"""
Builds THE canonical LoCoMo corpus + query set. Every system reads this one file,
so "same corpus, same queries, same gold" is true by construction rather than by
convention.

Corpus text is built ONLY from conversation.session_N turns. The annotation fields
(`observation`, `session_summary`, `event_summary`) are never ingested -- they are
human/model-written summaries of the dialogue and would leak answers.
"""
import argparse
import ast
import hashlib
import json
import os
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone

from paths import CORPUS, require_dataset

DATA = require_dataset()

MONTHS = {
    m.lower(): i
    for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"], 1)
}
DATE_RE = re.compile(
    r"^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})\s*$", re.I)

# Inferred from the data itself (see validate_evidence.py): cat 2 answers are dates
# held in session_N_date_time, cat 3 answers are inferences absent from turn text,
# cat 4 answers are near-verbatim in a single turn, cat 5 carries `adversarial_answer`
# and a null `answer`.
CATEGORY_LABELS = {
    "1": "multi-hop",
    "2": "temporal",
    "3": "open-domain/commonsense",
    "4": "single-hop",
    "5": "adversarial (unanswerable)",
}


def parse_dt(s):
    m = DATE_RE.match(s)
    if not m:
        raise ValueError(f"unparseable session date: {s!r}")
    hh, mm, ap, day, mon, yr = m.groups()
    hh = int(hh) % 12
    if ap.lower() == "pm":
        hh += 12
    key = mon.lower()
    if key not in MONTHS:
        raise ValueError(f"unknown month {mon!r} in {s!r}")
    return datetime(int(yr), MONTHS[key], int(day), hh, int(mm), tzinfo=timezone.utc)


def evidence_as_list(ev):
    """LoCoMo ships evidence as a real list in this file, but the field is a
    stringified list in other releases. Accept both; never assume."""
    if ev is None:
        return []
    if isinstance(ev, list):
        return [str(x) for x in ev]
    if isinstance(ev, str):
        try:
            v = ast.literal_eval(ev)
            return [str(x) for x in (v if isinstance(v, (list, tuple)) else [v])]
        except Exception:
            return [ev]
    return [str(ev)]


def turn_text(speaker, date_raw, text, caption):
    """The one text form every system indexes. The session date is included because
    LoCoMo's temporal answers live in session_N_date_time, not in the turn text -- no
    system could answer category 2 without it. The image caption is dialogue content
    (a shared photo) and is included for 37% of evidence turns."""
    photo = f" [shares a photo: {caption}]" if caption else ""
    return f"[{date_raw}] {speaker}: {text}{photo}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=CORPUS)
    ap.add_argument("--convs", default="", help="comma-separated sample_ids to keep (smoke tests)")
    args = ap.parse_args()

    raw = open(DATA, "rb").read()
    dataset_sha = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw)

    keep = set(x for x in args.convs.split(",") if x)
    conversations = []
    dropped_evidence_total = 0
    ev_per_cat = defaultdict(list)

    for conv in data:
        sid = conv["sample_id"]
        if keep and sid not in keep:
            continue
        cv = conv["conversation"]
        skeys = sorted((k for k in cv if re.fullmatch(r"session_\d+", k)),
                       key=lambda s: int(s.split("_")[1]))

        turns, byid = [], {}
        for k in skeys:
            n = int(k.split("_")[1])
            date_raw = cv.get(f"{k}_date_time")
            if not date_raw:
                raise ValueError(f"{sid}: missing {k}_date_time")
            dt = parse_dt(date_raw)
            for i, t in enumerate(cv[k]):
                # Convention verified against all 5,882 turns: dia_id == D<session>:<1-based index>
                expected = f"D{n}:{i+1}"
                if t["dia_id"] != expected:
                    raise ValueError(f"{sid}: dia_id {t['dia_id']} != {expected}")
                cap = t.get("blip_caption") or ""
                rec = {
                    "id": t["dia_id"],
                    "session": n,
                    "turn": i + 1,
                    "speaker": t["speaker"],
                    "date_raw": date_raw,
                    "date_iso": dt.isoformat(),
                    "raw_text": t["text"],
                    "caption": cap,
                    "text": turn_text(t["speaker"], date_raw, t["text"], cap),
                }
                turns.append(rec)
                byid[rec["id"]] = rec

        questions = []
        for qi, q in enumerate(conv["qa"]):
            cat = str(q["category"])
            named = evidence_as_list(q.get("evidence"))
            resolved = [e for e in named if e in byid]
            dropped = [e for e in named if e not in byid]
            dropped_evidence_total += len(dropped)
            ev_per_cat[cat].append(len(resolved))
            adversarial = cat == "5"
            # Category 5 is adversarial-by-construction: `answer` is null and the
            # listed evidence turn is the NEAR MISS (it describes the other speaker).
            # Retrieving it is not a success, so cat 5 carries no retrieval gold and
            # is scored only as an abstention task in Mode B.
            gold = [] if adversarial else resolved
            questions.append({
                "qid": f"{sid}#{qi}",
                "sample_id": sid,
                "category": cat,
                "category_label": CATEGORY_LABELS.get(cat, f"unknown-{cat}"),
                "question": q["question"],
                "answer": None if adversarial else q.get("answer"),
                "adversarial_answer": q.get("adversarial_answer") if adversarial else None,
                "gold_turn_ids": gold,
                "named_evidence": named,
                "resolved_evidence": resolved,
                "dropped_evidence": dropped,
                "answerable": (not adversarial) and len(gold) > 0,
                "adversarial": adversarial,
            })

        conversations.append({
            "sample_id": sid,
            "speaker_a": cv.get("speaker_a"),
            "speaker_b": cv.get("speaker_b"),
            "n_sessions": len(skeys),
            "turns": turns,
            "questions": questions,
        })

    n_turns = sum(len(c["turns"]) for c in conversations)
    n_q = sum(len(c["questions"]) for c in conversations)
    sizes = [len(c["turns"]) for c in conversations]

    # Hash of the retrieval corpus only (ids + indexed text). Any system whose
    # ingest does not reproduce this hash is not running the same benchmark.
    h = hashlib.sha256()
    for c in conversations:
        for t in c["turns"]:
            h.update(f"{c['sample_id']}\x1f{t['id']}\x1f{t['text']}\x1e".encode())
    corpus_sha = h.hexdigest()

    hq = hashlib.sha256()
    for c in conversations:
        for q in c["questions"]:
            hq.update(f"{q['qid']}\x1f{q['question']}\x1f{','.join(q['gold_turn_ids'])}\x1e".encode())
    query_sha = hq.hexdigest()

    cat_counts = Counter(q["category"] for c in conversations for q in c["questions"])
    answerable = Counter(q["category"] for c in conversations for q in c["questions"] if q["answerable"])

    out = {
        "meta": {
            "dataset_path": DATA,
            "dataset_sha256": dataset_sha,
            "corpus_sha256": corpus_sha,
            "query_sha256": query_sha,
            "n_conversations": len(conversations),
            "n_turns": n_turns,
            "n_questions": n_q,
            "corpus_sizes": sizes,
            "mean_corpus_size": statistics.mean(sizes) if sizes else 0,
            "dropped_evidence_ids": dropped_evidence_total,
            "text_template": "[{session_date}] {speaker}: {text}[ [shares a photo: {caption}]]",
            "category_labels": CATEGORY_LABELS,
            "category_counts": dict(sorted(cat_counts.items())),
            "answerable_counts": dict(sorted(answerable.items())),
            "mean_gold_per_category": {k: round(statistics.mean(v), 3) for k, v in sorted(ev_per_cat.items())},
            "ingested_fields": ["conversation.session_N[].text", "conversation.session_N[].blip_caption",
                                "conversation.session_N_date_time", "conversation.session_N[].speaker"],
            "excluded_fields": ["observation", "session_summary", "event_summary", "qa"],
        },
        "conversations": conversations,
    }

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(json.dumps(out["meta"], indent=2))


if __name__ == "__main__":
    main()
