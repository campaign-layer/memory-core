#!/usr/bin/env python3
"""
Mode B: QA accuracy with an LLM judge, over the SAME retrievals Mode A scored.

Per question: take the system's top-k retrieved items -> answer using ONLY those
items ("I don't know" permitted) -> judge against the gold answer, strict binary
with a one-line reason. Answerer and judge are both deepseek/deepseek-v4-flash via
OpenRouter.

Context is built from each system's NATIVE returned unit:
  * memory-core / bm25 / random -> the retrieved dialogue turns
  * mem0                        -> mem0's own consolidated memory texts
Substituting the original turns for mem0's memories would credit mem0 with
information its write path discarded, so it is not done.

Checkpoints to JSONL keyed by (system, k, qid); re-running resumes.
"""
import argparse
import asyncio
import glob
import hashlib
import json
import os
import random
import re
import sys
import time
from collections import Counter, defaultdict

try:
    import httpx
except ImportError:
    sys.exit(
        "error: this script needs httpx.\n"
        "       python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt\n"
        "       then run it with ./.venv/bin/python (./mode_b.sh does this for you)."
    )

from paths import CORPUS, MEM0_DIR, OUT, RANKINGS, require_corpus

MODEL = "deepseek/deepseek-v4-flash"
BASE = "https://openrouter.ai/api/v1/chat/completions"
PRICE_IN = 0.00000014
PRICE_OUT = 0.00000028

ANSWER_SYS = (
    "You answer questions about a long-running conversation between two people, using ONLY the "
    "numbered memories provided. Do not use outside knowledge and do not guess.\n"
    "If the memories do not contain the answer, reply exactly: I don't know\n"
    "Otherwise answer with the shortest possible span - a name, a phrase, or a date. Do not explain."
)

JUDGE_SYS = (
    "You are a strict grader. Reply with JSON only, no prose, no code fences: "
    '{"verdict":"CORRECT"|"INCORRECT","reason":"<one line>"}'
)


class Meter:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.reasoning_tokens = 0
        self.errors = 0
        self.retries = 0
        self.truncated = 0
        # OpenRouter reports the authoritative charge per call in usage.cost.
        self.reported_usd = 0.0

    async def add(self, ptok, ctok, rtok=0, cost=0.0, err=False, retries=0, truncated=False):
        async with self.lock:
            self.calls += 1
            self.prompt_tokens += ptok
            self.completion_tokens += ctok
            self.reasoning_tokens += rtok
            self.reported_usd += cost or 0.0
            if err:
                self.errors += 1
            if truncated:
                self.truncated += 1
            self.retries += retries

    @property
    def usd(self):
        # Prefer OpenRouter's reported charge; fall back to list price.
        return self.reported_usd or (self.prompt_tokens * PRICE_IN + self.completion_tokens * PRICE_OUT)

    def snap(self):
        return {"llm_calls": self.calls, "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "reasoning_tokens": self.reasoning_tokens,
                "llm_errors": self.errors, "retries": self.retries,
                "truncated_responses": self.truncated,
                "usd_cost_reported_by_openrouter": round(self.reported_usd, 6),
                "usd_cost_at_list_price": round(
                    self.prompt_tokens * PRICE_IN + self.completion_tokens * PRICE_OUT, 6)}


async def call_llm(client, key, meter, system, user, max_tokens=300, temperature=0.0):
    # reasoning is DISABLED explicitly: deepseek-v4-flash is a reasoning model and by
    # default spends the whole token budget on `reasoning`, returning content=null and
    # finish_reason="length". Same setting for the answerer, the judge and the oracle.
    body = {"model": MODEL, "temperature": temperature, "max_tokens": max_tokens,
            "reasoning": {"enabled": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last = None
    for attempt in range(5):
        try:
            r = await client.post(BASE, json=body, headers=headers, timeout=180.0)
            # OpenRouter prepends keep-alive blank lines / ": OPENROUTER PROCESSING"
            # comments before the JSON body. Strip before parsing or every long call
            # looks like a parse failure.
            raw = r.text.lstrip()
            if raw.startswith(":"):
                raw = "\n".join(l for l in raw.splitlines() if not l.startswith(":")).lstrip()
            if r.status_code != 200:
                last = f"HTTP {r.status_code}: {raw[:200]}"
                await asyncio.sleep(2 * (attempt + 1))
                continue
            d = json.loads(raw)
            if "error" in d and not d.get("choices"):
                last = f"api error: {str(d['error'])[:200]}"
                await asyncio.sleep(2 * (attempt + 1))
                continue
            u = d.get("usage") or {}
            ch = d["choices"][0]
            txt = (ch["message"].get("content") or "").strip()
            fin = ch.get("finish_reason")
            rtok = (u.get("completion_tokens_details") or {}).get("reasoning_tokens", 0) or 0
            await meter.add(u.get("prompt_tokens", 0), u.get("completion_tokens", 0), rtok,
                            u.get("cost", 0.0), retries=attempt, truncated=(fin == "length"))
            if not txt and fin == "length" and attempt < 2:
                # Should not happen with reasoning off; retry once with more headroom
                # rather than silently scoring an empty answer as wrong.
                body["max_tokens"] = max_tokens * 4
                last = "empty content, finish_reason=length"
                continue
            return txt, None
        except Exception as e:
            last = f"{type(e).__name__}: {e}"
            await asyncio.sleep(2 * (attempt + 1))
    await meter.add(0, 0, err=True, retries=5)
    return None, last


def parse_verdict(txt):
    if not txt:
        return None, "empty judge response"
    s = txt.strip()
    s = re.sub(r"^```(?:json)?", "", s).strip()
    s = re.sub(r"```$", "", s).strip()
    try:
        d = json.loads(s)
        v = str(d.get("verdict", "")).upper()
        if v in ("CORRECT", "INCORRECT"):
            return v == "CORRECT", str(d.get("reason", ""))[:300]
    except Exception:
        pass
    m = re.search(r"\b(INCORRECT|CORRECT)\b", s.upper())
    if m:
        return m.group(1) == "CORRECT", f"(loose parse) {s[:200]}"
    return None, f"unparseable: {s[:200]}"


def build_contexts(corpus, rank_dir, mem0_dir, systems):
    """system -> qid -> ordered list of context strings (that system's native units)."""
    turns = {}
    for c in corpus["conversations"]:
        for t in c["turns"]:
            turns[(c["sample_id"], t["id"])] = t["text"]

    ctx = {}
    for s in systems:
        if s == "oracle":
            continue
        if s.startswith("mem0"):
            # mem0's own memory texts, in retrieved order.
            per = {}
            for f in sorted(glob.glob(os.path.join(mem0_dir, "*.search.jsonl"))):
                for line in open(f):
                    if not line.strip():
                        continue
                    r = json.loads(line)
                    per[r["qid"]] = [h.get("memory") or "" for h in (r.get("hits") or [])]
            ctx[s] = per
            continue
        path = os.path.join(rank_dir, f"{s.replace(':', '_')}.jsonl")
        per = {}
        for line in open(path):
            if not line.strip():
                continue
            r = json.loads(line)
            seen, out = set(), []
            for it in r["items"]:
                for tid in it.get("turn_ids") or []:
                    if tid in seen:
                        continue
                    seen.add(tid)
                    out.append(turns.get((r["sample_id"], tid), ""))
            per[r["qid"]] = out
        ctx[s] = per
    return ctx


def oracle_context(corpus):
    turns = {}
    for c in corpus["conversations"]:
        for t in c["turns"]:
            turns[(c["sample_id"], t["id"])] = t["text"]
    per = {}
    for c in corpus["conversations"]:
        for q in c["questions"]:
            ids = q["gold_turn_ids"] or q["resolved_evidence"]
            per[q["qid"]] = [turns[(c["sample_id"], t)] for t in ids if (c["sample_id"], t) in turns]
    return per


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--rankings", default=RANKINGS)
    ap.add_argument("--mem0-dir", default=MEM0_DIR)
    ap.add_argument("--systems", default="memory-core:in-memory,bm25,random")
    ap.add_argument("--ks", default="10,30")
    ap.add_argument("--checkpoint", default=os.path.join(OUT, "mode_b.jsonl"))
    ap.add_argument("--concurrency", type=int, default=12)
    ap.add_argument("--oracle-n", type=int, default=300)
    ap.add_argument("--limit", type=int, default=0, help="cap questions per system (smoke)")
    ap.add_argument("--seed", type=int, default=20260729)
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        sys.exit("error: OPENROUTER_API_KEY is not set.\n"
                 "       Mode B calls a reader and a judge model over OpenRouter.\n"
                 "       Mode A (./mode_a.sh) needs no key and no network.")

    require_corpus(args.corpus)
    corpus = json.load(open(args.corpus))
    systems = [s for s in args.systems.split(",") if s]
    ks = [int(x) for x in args.ks.split(",") if x]

    questions = {q["qid"]: q for c in corpus["conversations"] for q in c["questions"]}
    ctx = build_contexts(corpus, args.rankings, args.mem0_dir, systems)
    if "oracle" in systems:
        ctx["oracle"] = oracle_context(corpus)

    # deterministic stratified subsample for the oracle upper bound
    oracle_qids = set()
    if "oracle" in systems:
        by_cat = defaultdict(list)
        for qid, q in questions.items():
            by_cat[q["category"]].append(qid)
        rng = random.Random(args.seed)
        total = sum(len(v) for v in by_cat.values())
        for cat, v in sorted(by_cat.items()):
            v = sorted(v)
            rng.shuffle(v)
            take = max(1, round(args.oracle_n * len(v) / total))
            oracle_qids.update(v[:take])

    os.makedirs(os.path.dirname(args.checkpoint) or ".", exist_ok=True)
    done = set()
    if os.path.exists(args.checkpoint):
        for line in open(args.checkpoint):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
                done.add((r["system"], r["k"], r["qid"]))
            except Exception:
                pass

    tasks = []
    for s in systems:
        qids = sorted(oracle_qids) if s == "oracle" else sorted(questions)
        if args.limit:
            qids = qids[: args.limit]
        for k in ([0] if s == "oracle" else ks):
            for qid in qids:
                if (s, k, qid) in done:
                    continue
                tasks.append((s, k, qid))

    print(f"systems={systems} ks={ks} pending={len(tasks)} (already done {len(done)})", flush=True)
    if not tasks:
        print("nothing to do")
        return

    meter = Meter()
    sem = asyncio.Semaphore(args.concurrency)
    out_lock = asyncio.Lock()
    fh = open(args.checkpoint, "a")
    t0 = time.time()
    counter = Counter()

    async def one(client, s, k, qid):
        q = questions[qid]
        items = ctx.get(s, {}).get(qid, [])
        used = items if s == "oracle" else items[:k]
        numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(used)) or "(no memories retrieved)"
        user = f"MEMORIES:\n{numbered}\n\nQUESTION: {q['question']}\nANSWER:"
        pred, err = await call_llm(client, key, meter, ANSWER_SYS, user, max_tokens=300)

        verdict, reason, jerr = None, None, None
        if pred is not None:
            if q["adversarial"]:
                ju = (f"The question below asks about something that DID NOT HAPPEN in the conversation, "
                      f"so there is no correct factual answer and a good system must decline.\n\n"
                      f"Question: {q['question']}\nPredicted answer: {pred}\n\n"
                      f"Mark CORRECT if the prediction declines, says it does not know, or says the "
                      f"conversation contains no such information. Mark INCORRECT if it asserts any "
                      f"specific factual answer.")
            else:
                ju = (f"Question: {q['question']}\nGold answer: {q['answer']}\nPredicted answer: {pred}\n\n"
                      f"Mark CORRECT if the prediction conveys the same core information as the gold "
                      f"answer. Accept paraphrases, equivalent date formats, and extra detail that does "
                      f"not contradict the gold. Mark INCORRECT if it names a different entity, date or "
                      f"value, contradicts the gold, or is a refusal such as \"I don't know\".")
            jtxt, jerr = await call_llm(client, key, meter, JUDGE_SYS, ju, max_tokens=300)
            verdict, reason = parse_verdict(jtxt)

        row = {"system": s, "k": k, "qid": qid, "category": q["category"],
               "adversarial": q["adversarial"], "n_context": len(used),
               "question": q["question"], "gold": q["answer"],
               "adversarial_answer": q.get("adversarial_answer"),
               "prediction": pred, "correct": verdict, "judge_reason": reason,
               "answer_error": err, "judge_error": jerr}
        async with out_lock:
            fh.write(json.dumps(row) + "\n")
            fh.flush()
            counter[(s, k)] += 1
            n = sum(counter.values())
            if n % 200 == 0:
                el = time.time() - t0
                print(f"  {n}/{len(tasks)} in {el:.0f}s ({n/max(el,1):.1f}/s) "
                      f"usd={meter.usd:.3f} errors={meter.errors} trunc={meter.truncated}", flush=True)

    async def guarded(client, s, k, qid):
        async with sem:
            await one(client, s, k, qid)

    limits = httpx.Limits(max_connections=args.concurrency * 2, max_keepalive_connections=args.concurrency)
    async with httpx.AsyncClient(limits=limits) as client:
        await asyncio.gather(*(guarded(client, s, k, qid) for s, k, qid in tasks))
    fh.close()

    print(f"\ndone in {time.time()-t0:.0f}s  meter={json.dumps(meter.snap())}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
