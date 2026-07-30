#!/usr/bin/env python3
"""
mem0 (OSS) on LoCoMo, one conversation per process.

Reads the SAME work/corpus.json every other system reads. Ingests one mem0 add()
per dialogue turn -- matching memory-core's one-memory-per-turn granularity -- so
the LLM write path (extract -> compare -> ADD/UPDATE/DELETE/NOOP) is exercised
exactly as shipped.

Emits:
  work/mem0/<sid>.adds.jsonl      one line per add: events, latency, token usage
  work/mem0/<sid>.memories.json   every surviving memory with its metadata
  work/mem0/<sid>.search.jsonl    one line per question: retrieved memory ids + scores
  work/mem0/<sid>.done.json       completion marker + cost/wall-clock accounting

Attribution of a retrieved mem0 memory back to a gold turn is done OFFLINE by
attribute_mem0.py, from these dumps, so it can be revised without re-paying ingest.
"""
import argparse
import json
import os
import sys
import time
import traceback

from paths import CORPUS, WORK, require_corpus

MODEL = "deepseek/deepseek-v4-flash"
# OpenRouter list price for deepseek/deepseek-v4-flash, USD per token, captured
# 2026-07-29 from GET /api/v1/models.
PRICE_IN = 0.00000014
PRICE_OUT = 0.00000028

EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
EMBED_DIMS = 384


class Meter:
    """Exact token accounting: wraps the OpenAI client mem0 actually calls."""

    def __init__(self):
        self.calls = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.errors = 0
        self.llm_seconds = 0.0
        self.empty_content = 0
        self.reported_usd = 0.0

    def wrap(self, memory):
        create = memory.llm.client.chat.completions.create

        def wrapped(*a, **kw):
            # deepseek-v4-flash is a REASONING model. Left at its default it spends the
            # whole max_tokens budget on `reasoning` and returns content=null, which
            # mem0 cannot parse ("Error parsing extraction response: 'NoneType' object
            # has no attribute 'strip'") -- observed on ~2% of adds, i.e. silently
            # dropped memories, plus ~10x the completion tokens and latency.
            # Disabling reasoning makes it behave as a chat model. The answerer and
            # judge in Mode B are configured identically, so one model behaviour is
            # used everywhere in this harness.
            # MEM0_REASONING=on runs the sensitivity variant with the provider default
            # (reasoning ENABLED), which is what mem0 out-of-the-box produces.
            if os.environ.get("MEM0_REASONING", "off").lower() != "on":
                eb = dict(kw.get("extra_body") or {})
                eb.setdefault("reasoning", {"enabled": False})
                kw["extra_body"] = eb
            t0 = time.time()
            try:
                r = create(*a, **kw)
            except Exception:
                self.errors += 1
                self.llm_seconds += time.time() - t0
                raise
            self.llm_seconds += time.time() - t0
            self.calls += 1
            u = getattr(r, "usage", None)
            if u is not None:
                self.prompt_tokens += getattr(u, "prompt_tokens", 0) or 0
                self.completion_tokens += getattr(u, "completion_tokens", 0) or 0
                # OpenRouter reports the authoritative charge per call.
                self.reported_usd += float(getattr(u, "cost", 0.0) or 0.0)
            if getattr(r, "choices", None):
                msg = r.choices[0].message
                if not (getattr(msg, "content", None) or "").strip():
                    self.empty_content += 1
            return r

        memory.llm.client.chat.completions.create = wrapped
        return memory

    @property
    def usd(self):
        # Prefer OpenRouter's reported charge; fall back to list price.
        return self.reported_usd or (self.prompt_tokens * PRICE_IN + self.completion_tokens * PRICE_OUT)

    def snapshot(self):
        return {
            "llm_calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "llm_errors": self.errors,
            "empty_content_responses": self.empty_content,
            "llm_seconds": round(self.llm_seconds, 1),
            "usd_cost": round(self.usd, 6),
            "usd_cost_reported_by_openrouter": round(self.reported_usd, 6),
            "usd_cost_at_list_price": round(
                self.prompt_tokens * PRICE_IN + self.completion_tokens * PRICE_OUT, 6),
            "price_in_per_token": PRICE_IN,
            "price_out_per_token": PRICE_OUT,
            "reasoning": "disabled via extra_body.reasoning.enabled=false",
        }


def build_memory(sid, workdir):
    from mem0 import Memory

    qdrant_path = os.path.join(workdir, "qdrant", sid)
    hist = os.path.join(workdir, "mem0_history")
    os.makedirs(qdrant_path, exist_ok=True)
    os.makedirs(hist, exist_ok=True)
    cfg = {
        # mem0's OpenAILLM auto-routes through OpenRouter when OPENROUTER_API_KEY is
        # set (mem0/llms/openai.py). No monkeypatching of the provider needed.
        "llm": {"provider": "openai", "config": {"model": MODEL, "temperature": 0.1, "max_tokens": 2000}},
        # OpenRouter serves no embeddings endpoint, so the embedder is local.
        "embedder": {"provider": "huggingface",
                     "config": {"model": EMBED_MODEL, "embedding_dims": EMBED_DIMS}},
        "vector_store": {"provider": "qdrant",
                         "config": {"collection_name": f"locomo_{sid.replace('-', '_')}",
                                    "path": qdrant_path,
                                    "embedding_model_dims": EMBED_DIMS,
                                    "on_disk": True}},
        "history_db_path": os.path.join(hist, f"{sid}.db"),
    }
    return Memory.from_config(cfg), cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", required=True)
    ap.add_argument("--corpus", default=CORPUS)
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--depth", type=int, default=30)
    ap.add_argument("--max-turns", type=int, default=0, help="0 = all (smoke tests only)")
    ap.add_argument("--max-questions", type=int, default=0, help="0 = all (smoke tests only)")
    args = ap.parse_args()

    if not os.environ.get("OPENROUTER_API_KEY"):
        sys.exit("error: OPENROUTER_API_KEY is not set.\n"
                 "       mem0's write path extracts facts with an LLM, so it needs a key.\n"
                 "       This run costs money; see README.md for the recorded totals.")

    require_corpus(args.corpus)
    corpus = json.load(open(args.corpus))
    conv = next((c for c in corpus["conversations"] if c["sample_id"] == args.sid), None)
    if conv is None:
        sys.exit(f"conversation {args.sid} not in corpus")

    turns = conv["turns"][: args.max_turns] if args.max_turns else conv["turns"]
    questions = conv["questions"][: args.max_questions] if args.max_questions else conv["questions"]

    outdir = os.path.join(args.work, "mem0")
    os.makedirs(outdir, exist_ok=True)
    adds_path = os.path.join(outdir, f"{args.sid}.adds.jsonl")
    search_path = os.path.join(outdir, f"{args.sid}.search.jsonl")
    mem_path = os.path.join(outdir, f"{args.sid}.memories.json")
    done_path = os.path.join(outdir, f"{args.sid}.done.json")

    if os.path.exists(done_path):
        print(f"[{args.sid}] already complete, nothing to do")
        return

    meter = Meter()
    memory, cfg = build_memory(args.sid, args.work)
    meter.wrap(memory)

    # ---- resume: replay which turns already landed -------------------------------
    ingested = set()
    if os.path.exists(adds_path):
        for line in open(adds_path):
            line = line.strip()
            if not line:
                continue
            try:
                ingested.add(json.loads(line)["turn_id"])
            except Exception:
                pass
    print(f"[{args.sid}] {len(turns)} turns, {len(questions)} questions, {len(ingested)} turns already ingested",
          flush=True)

    # ---- ingest ------------------------------------------------------------------
    t_ing0 = time.time()
    af = open(adds_path, "a")
    for i, t in enumerate(turns):
        if t["id"] in ingested:
            continue
        before = meter.snapshot()
        t0 = time.time()
        err = None
        res = None
        for attempt in range(4):
            try:
                res = memory.add(
                    [{"role": "user", "content": t["text"]}],
                    user_id=args.sid,
                    metadata={"turn_id": t["id"], "session": t["session"], "date": t["date_raw"]},
                    infer=True,
                )
                err = None
                break
            except Exception as e:
                err = f"{type(e).__name__}: {e}"
                time.sleep(2 * (attempt + 1))
        dt = time.time() - t0
        after = meter.snapshot()
        events = []
        if isinstance(res, dict):
            for r in res.get("results", []) or []:
                events.append({"id": r.get("id"), "event": r.get("event"), "memory": r.get("memory")})
        af.write(json.dumps({
            "turn_id": t["id"], "i": i, "seconds": round(dt, 3), "error": err,
            "n_events": len(events), "events": events,
            "llm_calls": after["llm_calls"] - before["llm_calls"],
            "prompt_tokens": after["prompt_tokens"] - before["prompt_tokens"],
            "completion_tokens": after["completion_tokens"] - before["completion_tokens"],
        }) + "\n")
        af.flush()
        if (i + 1) % 25 == 0:
            el = time.time() - t_ing0
            print(f"[{args.sid}] add {i+1}/{len(turns)} elapsed={el:.0f}s "
                  f"calls={after['llm_calls']} usd={after['usd_cost']:.4f}", flush=True)
    af.close()
    ingest_seconds = time.time() - t_ing0
    ingest_meter = meter.snapshot()

    # ---- dump every surviving memory (provenance source for attribution) ---------
    all_mems = memory.get_all(filters={"user_id": args.sid}, top_k=100000)
    rows = all_mems.get("results", all_mems) if isinstance(all_mems, dict) else all_mems
    json.dump(rows, open(mem_path, "w"))
    print(f"[{args.sid}] ingest done in {ingest_seconds:.0f}s; {len(rows)} memories survive "
          f"from {len(turns)} turns; {ingest_meter['llm_calls']} llm calls "
          f"${ingest_meter['usd_cost']:.4f}", flush=True)

    # ---- search ------------------------------------------------------------------
    searched = set()
    if os.path.exists(search_path):
        for line in open(search_path):
            line = line.strip()
            if not line:
                continue
            try:
                searched.add(json.loads(line)["qid"])
            except Exception:
                pass

    t_s0 = time.time()
    sf = open(search_path, "a")
    for j, q in enumerate(questions):
        if q["qid"] in searched:
            continue
        t0 = time.time()
        err, hits = None, []
        try:
            # threshold=0.0 measures RANKING rather than mem0's default 0.1 gate,
            # mirroring minScore=0 for memory-core. The default gate is reported
            # separately by the scorer.
            r = memory.search(q["question"], filters={"user_id": args.sid},
                              top_k=args.depth, threshold=0.0)
            got = r.get("results", r) if isinstance(r, dict) else r
            for h in got or []:
                hits.append({"id": h.get("id"), "score": h.get("score"),
                             "memory": h.get("memory"), "metadata": h.get("metadata")})
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
        sf.write(json.dumps({"qid": q["qid"], "sample_id": args.sid, "error": err,
                             "latency_ms": round((time.time() - t0) * 1000, 3),
                             "hits": hits}) + "\n")
        sf.flush()
        if (j + 1) % 100 == 0:
            print(f"[{args.sid}] search {j+1}/{len(questions)}", flush=True)
    sf.close()
    search_seconds = time.time() - t_s0

    total = meter.snapshot()
    done = {
        "sample_id": args.sid,
        "model": MODEL,
        "embedder": EMBED_MODEL, "embedding_dims": EMBED_DIMS,
        "vector_store": "qdrant (local, on_disk)",
        "config": cfg,
        "turns_ingested": len(turns),
        "questions": len(questions),
        "memories_surviving": len(rows),
        "ingest_seconds": round(ingest_seconds, 1),
        "search_seconds": round(search_seconds, 1),
        "ingest_meter": ingest_meter,
        "total_meter": total,
        "search_threshold": 0.0,
        "rerank": False,
        "depth": args.depth,
    }
    json.dump(done, open(done_path, "w"), indent=2)
    print(f"[{args.sid}] COMPLETE ingest={ingest_seconds:.0f}s search={search_seconds:.0f}s "
          f"calls={total['llm_calls']} usd=${total['usd_cost']:.4f}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
