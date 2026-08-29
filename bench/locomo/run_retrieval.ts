/**
 * Mode A retrieval for every system that lives in this repo (memory-core providers)
 * plus the two reference points (bm25, random).
 *
 * Reads work/corpus.json -- the same file mem0 reads -- and emits one JSONL per
 * system in the shared ranking format, so a single scorer grades everything.
 *
 * Fairness by construction: identical corpus text, identical queries, identical
 * retrieval depth, one fresh index per conversation for every system.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createMemoryProvider, type MemoryProviderKind } from "../../src/providers/factory.js";
import type { MemoryProvider } from "../../src/provider.js";
import type { MemoryRecord } from "../../src/types.js";
import { createBm25System } from "../systems/bm25.js";
import { createRandomSystem } from "../systems/random.js";
import type { MaterializedMemory, RankedHit } from "../types.js";
import { CORPUS, RANKINGS, requireCorpus } from "./paths.js";

const DEPTH = 30;
const SEED = 20260729;

// memory-core's own ingest defaults (src/service.ts DEFAULT_CONFIDENCE / DEFAULT_IMPORTANCE).
// Ranking is invariant to the exact values because they are uniform across the corpus:
// InMemoryProvider computes score = relevance * (0.7 + 0.3*quality), a monotone
// transform of relevance when quality is constant.
const CONFIDENCE = 0.7;
const IMPORTANCE = 0.5;

const TENANT = "locomo";
const APP = "locomo";

interface Turn {
  id: string; session: number; turn: number; speaker: string;
  date_raw: string; date_iso: string; raw_text: string; caption: string; text: string;
}
interface Question {
  qid: string; sample_id: string; category: string; question: string;
  gold_turn_ids: string[]; answerable: boolean; adversarial: boolean;
}
interface Conversation { sample_id: string; turns: Turn[]; questions: Question[] }
interface Corpus { meta: Record<string, any>; conversations: Conversation[] }

function materialize(t: Turn): MaterializedMemory {
  return {
    id: t.id,
    sessionId: `session_${t.session}`,
    sessionIndex: t.session,
    dayOffset: 0,
    minuteOfDay: 0,
    memoryType: "episode",
    text: t.text,
    role: "gold",
    itemId: null,
    confidence: CONFIDENCE,
    importance: IMPORTANCE,
    timestampIso: t.date_iso,
  };
}

/**
 * decayPolicy is "none" on purpose. memory-core's shipped default is
 * { kind: "time", ttlDays: 180 } and every LoCoMo session predates that window, so
 * the default would mark the ENTIRE corpus expired and return zero hits for every
 * query. That is a harness artifact, not a property of the retriever. Reported.
 */
function toRecord(m: MaterializedMemory, actorId: string): MemoryRecord {
  return {
    id: m.id,
    tenantId: TENANT,
    spaceId: actorId,
    appId: APP,
    actorId,
    threadId: m.sessionId,
    scope: "actor",
    memoryType: m.memoryType,
    text: m.text,
    summary: null,
    metadata: { sessionId: m.sessionId, sessionIndex: m.sessionIndex },
    confidence: m.confidence,
    importance: m.importance,
    status: "active",
    source: { sourceType: "locomo", sourceId: m.id, sourceSessionId: m.sessionId },
    decayPolicy: { kind: "none" },
    firstSeenAt: m.timestampIso,
    lastSeenAt: m.timestampIso,
    createdAt: m.timestampIso,
    updatedAt: m.timestampIso,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0, accessCount: 0 },
  };
}

interface Runner {
  name: string;
  note: string;
  /** Fresh index per conversation, then rank every question in that conversation. */
  run(conv: Conversation): Promise<{ rows: any[]; ingestMs: number; searchMs: number }>;
}

function providerRunner(kind: MemoryProviderKind): Runner {
  return {
    name: `memory-core:${kind}`,
    note: `src/providers/factory.ts kind=${kind}, minScore=0, limit=${DEPTH}`,
    async run(conv) {
      const provider: MemoryProvider = createMemoryProvider({ kind });
      const records = conv.turns.map((t) => toRecord(materialize(t), conv.sample_id));
      const t0 = performance.now();
      await provider.ingest(records);
      const ingestMs = performance.now() - t0;

      const rows: any[] = [];
      let searchMs = 0;
      for (const q of conv.questions) {
        const s0 = performance.now();
        // minScore 0: measure RANKING, not an arbitrary score gate. The provider's
        // own default gate (0.2) is reported separately by the scorer.
        const hits = await provider.search({
          query: q.question,
          filters: { tenantId: TENANT, appId: APP, actorId: conv.sample_id },
          limit: DEPTH,
          minScore: 0,
        });
        const dt = performance.now() - s0;
        searchMs += dt;
        rows.push({
          system: this.name, sample_id: conv.sample_id, qid: q.qid,
          latency_ms: dt,
          items: hits.map((h) => ({ turn_ids: [h.memory.id], score: h.score })),
        });
      }
      if (provider.close) await provider.close();
      return { rows, ingestMs, searchMs };
    },
  };
}

function benchSystemRunner(name: string, make: () => any, note: string): Runner {
  return {
    name,
    note,
    async run(conv) {
      const sys = make();
      const mems = conv.turns.map(materialize);
      const t0 = performance.now();
      if (sys.setup) await sys.setup();
      await sys.ingest(mems);
      const ingestMs = performance.now() - t0;

      const rows: any[] = [];
      let searchMs = 0;
      for (const q of conv.questions) {
        const s0 = performance.now();
        const hits: RankedHit[] = await sys.search(q.question, DEPTH);
        const dt = performance.now() - s0;
        searchMs += dt;
        rows.push({
          system: name, sample_id: conv.sample_id, qid: q.qid,
          latency_ms: dt,
          items: hits.map((h) => ({ turn_ids: [h.id], score: h.score })),
        });
      }
      if (sys.teardown) await sys.teardown();
      return { rows, ingestMs, searchMs };
    },
  };
}

function buildRunner(name: string): Runner {
  if (name.startsWith("memory-core:")) {
    return providerRunner(name.slice("memory-core:".length) as MemoryProviderKind);
  }
  if (name === "bm25") {
    return benchSystemRunner("bm25", createBm25System,
      "bench/systems/bm25.ts (Okapi k1=1.5 b=0.75, bench tokenizer, no stemming)");
  }
  if (name === "random") {
    return benchSystemRunner("random", () => createRandomSystem(SEED),
      `bench/systems/random.ts seeded shuffle control (seed=${SEED})`);
  }
  throw new Error(`unknown system: ${name}`);
}

const USAGE = [
  "LoCoMo Mode A retrieval for the in-repo systems. No API key, no network, no cost.",
  "",
  "  npx tsx run_retrieval.ts [--systems=a,b,c] [--corpus=FILE] [--out=DIR]",
  "",
  "  --systems=  memory-core:in-memory | memory-core:file | memory-core:enhanced |",
  "              memory-core:dual-layer | bm25 | random",
  "              (default memory-core:in-memory,bm25,random)",
  "",
  "Needs the canonical corpus from build_corpus.py. Resumable per conversation.",
  "For the hybrid (embedder) configurations use run_retrieval2.ts.",
].join("\n");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const get = (k: string, d?: string) => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const corpusPath = get("corpus", CORPUS)!;
  const outDir = get("out", RANKINGS)!;
  const systems = (get("systems", "memory-core:in-memory,bm25,random")!).split(",").filter(Boolean);

  requireCorpus(corpusPath);
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

  // Same-corpus assertion: recompute the hash the builder wrote.
  const h = createHash("sha256");
  for (const c of corpus.conversations) {
    for (const t of c.turns) h.update(`${c.sample_id}\x1f${t.id}\x1f${t.text}\x1e`);
  }
  const got = h.digest("hex");
  if (got !== corpus.meta.corpus_sha256) {
    throw new Error(`corpus hash mismatch: ${got} != ${corpus.meta.corpus_sha256}`);
  }
  console.log(`corpus ok: ${corpus.meta.n_turns} turns, ${corpus.meta.n_questions} questions, sha=${got.slice(0, 12)}`);

  mkdirSync(outDir, { recursive: true });

  for (const name of systems) {
    const runner = buildRunner(name);
    const file = path.join(outDir, `${name.replace(/[:/]/g, "_")}.jsonl`);
    const metaFile = path.join(outDir, `${name.replace(/[:/]/g, "_")}.meta.json`);

    // Resume: skip conversations already written.
    const done = new Set<string>();
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { done.add(JSON.parse(line).sample_id); } catch { /* partial line */ }
      }
    }

    let ingestMs = 0, searchMs = 0, nq = 0, nrec = 0;
    const t0 = Date.now();
    for (const conv of corpus.conversations) {
      if (done.has(conv.sample_id)) { console.log(`  [${name}] ${conv.sample_id} cached`); continue; }
      const r = await runner.run(conv);
      appendFileSync(file, r.rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
      ingestMs += r.ingestMs; searchMs += r.searchMs; nq += r.rows.length; nrec += conv.turns.length;
      console.log(`  [${name}] ${conv.sample_id}: ${conv.turns.length} turns ingest=${r.ingestMs.toFixed(0)}ms, ${r.rows.length} queries search=${r.searchMs.toFixed(0)}ms`);
    }
    const wall = Date.now() - t0;
    const meta = {
      system: name, note: runner.note, depth: DEPTH,
      records_ingested: nrec, queries: nq,
      ingest_ms: Math.round(ingestMs), search_ms: Math.round(searchMs), wall_ms: wall,
      ingest_records_per_sec: ingestMs > 0 ? Math.round((nrec / ingestMs) * 1000) : null,
      mean_search_ms: nq > 0 ? +(searchMs / nq).toFixed(3) : null,
      llm_calls: 0, usd_cost: 0,
      confidence: CONFIDENCE, importance: IMPORTANCE, decay_policy: "none",
    };
    if (nq > 0) writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    console.log(`[${name}] done: ingest ${(ingestMs / 1000).toFixed(1)}s, search ${(searchMs / 1000).toFixed(1)}s, wall ${(wall / 1000).toFixed(1)}s`);
  }
}

main().catch((e) => {
  console.error(`\n${e?.message ?? e}\n`);
  process.exit(1);
});
