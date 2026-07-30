/**
 * Mode A retrieval for memory-core providers at a PINNED commit.
 *
 * A working tree can move under a running benchmark -- on the recorded run the
 * checkout advanced one commit mid-flight -- so this runner imports the factory from
 * an EXPLICIT repo path (--repo, default: this repo) and records that path's resolved
 * SHA in the output meta. No number depends on whatever HEAD happened to be.
 *
 * To pin a specific commit, hand it a git worktree:
 *   git worktree add /tmp/mc-pinned <sha> && npx tsx run_retrieval2.ts --repo=/tmp/mc-pinned ...
 *
 * Hybrid safety: when --embedder=local, the run ABORTS unless the vector path is
 * demonstrably live (stored document vectors > 0 AND retrieved hits actually carry
 * a vector credit). Silently measuring BM25 and labelling it hybrid is the exact
 * failure mode this guard exists to prevent.
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CORPUS, RANKINGS, REPO_ROOT, requireCorpus } from "./paths.js";

const DEPTH = 30;
const CONFIDENCE = 0.7;   // src/service.ts DEFAULT_CONFIDENCE
const IMPORTANCE = 0.5;   // src/service.ts DEFAULT_IMPORTANCE
const TENANT = "locomo";
const APP = "locomo";

interface Turn { id: string; session: number; date_iso: string; text: string }
interface Question { qid: string; question: string }
interface Conversation { sample_id: string; turns: Turn[]; questions: Question[] }

function toRecord(t: Turn, actorId: string): any {
  return {
    id: t.id,
    tenantId: TENANT, appId: APP, actorId,
    threadId: `session_${t.session}`,
    scope: "actor",
    memoryType: "episode",
    text: t.text,
    summary: null,
    metadata: { sessionIndex: t.session },
    confidence: CONFIDENCE,
    importance: IMPORTANCE,
    status: "active",
    source: { sourceType: "locomo", sourceId: t.id, sourceSessionId: `session_${t.session}` },
    // "none" on purpose: the shipped default is time/180d and every LoCoMo session
    // predates that window, so the default expires the whole corpus and returns
    // nothing. A harness artifact, not a retriever property. Reported.
    decayPolicy: { kind: "none" },
    firstSeenAt: t.date_iso, lastSeenAt: t.date_iso,
    createdAt: t.date_iso, updatedAt: t.date_iso,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0, accessCount: 0 },
  };
}

const VECTOR_REASON = /vector/i;

const USAGE = [
  "LoCoMo Mode A retrieval for a memory-core provider at an explicit repo path.",
  "",
  "  npx tsx run_retrieval2.ts --name=LABEL [options]",
  "",
  "  --name=LABEL    required. Names the output ranking file and the report row.",
  "  --repo=DIR      repo/worktree to import the provider factory from (default: this repo)",
  "  --kind=KIND     provider kind (default in-memory)",
  "  --embedder=K    none | local | hash (default none = BM25-only)",
  "  --rrfk=N        RRF constant for the hybrid fusion (default: the provider's own)",
  "  --corpus=FILE   canonical corpus (default work/corpus.json)",
  "  --out=DIR       ranking output directory (default work/rankings)",
  "",
  "With --embedder=local the run ABORTS unless the vector leg is demonstrably live.",
  "Name the output honestly: an embedder=none run is BM25-only, not hybrid.",
].join("\n");

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(USAGE);
    return;
  }
  const get = (k: string, d?: string) => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };

  const repo = get("repo", REPO_ROOT)!;
  const kind = get("kind", "in-memory")!;
  const embedderKind = get("embedder", "none")!;
  const rrfKRaw = get("rrfk");
  const rrfK = rrfKRaw ? Number(rrfKRaw) : undefined;
  const name = get("name")!;
  const corpusPath = get("corpus", CORPUS)!;
  const outDir = get("out", RANKINGS)!;
  if (!name) {
    console.error(`${USAGE}\n\nerror: --name is required (it labels the output ranking file)`);
    process.exit(2);
  }
  requireCorpus(corpusPath);

  const sha = execSync(`git -C ${repo} rev-parse HEAD`, { encoding: "utf8" }).trim();
  const shaShort = sha.slice(0, 7);

  const factoryUrl = pathToFileURL(path.join(repo, "src/providers/factory.js")).href;
  const { createMemoryProvider } = (await import(factoryUrl)) as any;

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  console.log(`[${name}] repo=${repo} sha=${shaShort} kind=${kind} embedder=${embedderKind} rrfK=${rrfK ?? "default(60)"}`);
  console.log(`[${name}] corpus ${corpus.meta.n_turns} turns / ${corpus.meta.n_questions} questions sha=${corpus.meta.corpus_sha256.slice(0, 12)}`);

  mkdirSync(outDir, { recursive: true });
  const safe = name.replace(/[:/]/g, "_");
  const file = path.join(outDir, `${safe}.jsonl`);
  const metaFile = path.join(outDir, `${safe}.meta.json`);

  const done = new Set<string>();
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { done.add(JSON.parse(line).sample_id); } catch { /* partial */ }
    }
  }

  let ingestMs = 0, searchMs = 0, nq = 0, nrec = 0;
  let hitsWithVector = 0, hitsTotal = 0, vectorOnlyHits = 0, totalVectorCount = 0;
  const t0 = Date.now();

  for (const conv of corpus.conversations as Conversation[]) {
    if (done.has(conv.sample_id)) { console.log(`  ${conv.sample_id} cached`); continue; }

    const provider: any = createMemoryProvider({
      kind,
      ...(embedderKind === "none" ? {} : { embedderSpec: { kind: embedderKind } }),
      ...(rrfK !== undefined ? { rrfK } : {}),
    });

    const records = conv.turns.map((t) => toRecord(t, conv.sample_id));
    const ti = performance.now();
    // ingest() awaits embedding on the write path, so vectors are warm immediately.
    // restore() would background the backfill and require awaitEmbeddings(); not used.
    await provider.ingest(records);
    ingestMs += performance.now() - ti;

    const vc = typeof provider.vectorCount === "number" ? provider.vectorCount : -1;
    totalVectorCount += Math.max(0, vc);
    if (embedderKind !== "none" && vc === 0) {
      throw new Error(`[${name}] ${conv.sample_id}: embedder=${embedderKind} but vectorCount=0 — ` +
        `the vector path is NOT live; refusing to report BM25 as hybrid`);
    }

    const rows: any[] = [];
    for (const q of conv.questions) {
      const s0 = performance.now();
      const hits: any[] = await provider.search({
        query: q.question,
        filters: { tenantId: TENANT, appId: APP, actorId: conv.sample_id },
        limit: DEPTH,
        minScore: 0,
      });
      searchMs += performance.now() - s0;
      for (const h of hits) {
        hitsTotal++;
        const reasons: string[] = h.reasons ?? [];
        const hasVec = reasons.some((r) => VECTOR_REASON.test(r)) || h.components?.vector !== undefined;
        if (hasVec) hitsWithVector++;
        if (reasons.includes("vector match")) vectorOnlyHits++;
      }
      rows.push({
        system: name, sample_id: conv.sample_id, qid: q.qid,
        items: hits.map((h) => ({ turn_ids: [h.memory.id], score: h.score })),
      });
    }
    appendFileSync(file, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    nq += rows.length; nrec += conv.turns.length;
    console.log(`  ${conv.sample_id}: ${conv.turns.length} turns vectors=${vc} ${rows.length} queries`);
    if (provider.close) await provider.close();
  }

  // Hard guard: hybrid must show real vector participation, not just stored vectors.
  if (embedderKind !== "none" && nq > 0 && hitsWithVector === 0) {
    throw new Error(`[${name}] embedder=${embedderKind} but ZERO retrieved hits carried a vector ` +
      `credit across ${hitsTotal} hits — refusing to report BM25 as hybrid`);
  }

  const meta = {
    system: name,
    note: `${repo}@${shaShort} factory kind=${kind} embedder=${embedderKind}`
        + (rrfK !== undefined ? ` rrfK=${rrfK}` : " rrfK=default(60)")
        + `, minScore=0, limit=${DEPTH}`,
    repo, git_sha: sha, git_sha_short: shaShort,
    provider_kind: kind, embedder: embedderKind,
    embedder_model: embedderKind === "local" ? "Xenova/bge-small-en-v1.5 (384d, local ONNX)" : null,
    rrf_k: rrfK ?? 60, rrf_k_explicit: rrfK !== undefined,
    vector_min_similarity: 0.25,
    depth: DEPTH, records_ingested: nrec, queries: nq,
    ingest_ms: Math.round(ingestMs), search_ms: Math.round(searchMs), wall_ms: Date.now() - t0,
    ingest_records_per_sec: ingestMs > 0 ? Math.round((nrec / ingestMs) * 1000) : null,
    mean_search_ms: nq > 0 ? +(searchMs / nq).toFixed(3) : null,
    llm_calls: 0, usd_cost: 0,
    confidence: CONFIDENCE, importance: IMPORTANCE, decay_policy: "none",
    vector_path_live: embedderKind === "none" ? null : {
      stored_document_vectors: totalVectorCount,
      hits_total: hitsTotal,
      hits_with_vector_credit: hitsWithVector,
      hits_with_vector_credit_pct: hitsTotal ? +(100 * hitsWithVector / hitsTotal).toFixed(2) : 0,
      vector_only_hits: vectorOnlyHits,
    },
  };
  if (nq > 0) writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  console.log(`[${name}] ingest ${(ingestMs / 1000).toFixed(1)}s search ${(searchMs / 1000).toFixed(1)}s`);
  if (embedderKind !== "none") {
    console.log(`[${name}] VECTOR PATH LIVE: vectors=${totalVectorCount} ` +
      `hits_with_vector_credit=${hitsWithVector}/${hitsTotal} ` +
      `(${(100 * hitsWithVector / Math.max(1, hitsTotal)).toFixed(1)}%) vector_only=${vectorOnlyHits}`);
  }
}

main().catch((e) => {
  console.error(`\n${e?.message ?? e}\n`);
  process.exit(1);
});
