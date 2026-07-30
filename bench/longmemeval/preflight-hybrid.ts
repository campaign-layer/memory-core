/**
 * Preflight for the hybrid variants. Must pass before any hybrid number is trusted.
 *
 * The provider degrades to BM25-only BY DESIGN when the embedder fails, so a broken
 * model load produces a plausible-looking "hybrid" result. This asserts:
 *   1. the vector leg actually ran (hits carry a vector credit),
 *   2. vectors exist for the whole corpus after ingest() (no background backfill race),
 *   3. rrfK=5 and rrfK=60 really do produce different rankings,
 *   4. passing a ready shared embedder is equivalent to passing embedderSpec,
 *      which is the shortcut the harness relies on for speed.
 */
import { buildCorpus, listQuestionIds, loadQuestion, toMaterialized } from "./dataset.js";
import { BENCH_ACTOR, BENCH_APP, BENCH_TENANT, toMemoryRecord } from "../types.js";
import { createMemoryProvider } from "../../src/providers/factory.js";
import { requirePrepared } from "./paths.js";
import { HYBRID_EMBEDDER_SPEC, getSharedEmbedder, RETRIEVAL_DEPTH } from "./systems.js";

requirePrepared();
const first = listQuestionIds()[0];
if (!first) {
  console.error("no prepared questions found. Run prepare.ts (or ./run-modeA.sh) first.");
  process.exit(2);
}
const qid = first;
const corpus = buildCorpus(loadQuestion(qid));
const memories = toMaterialized(corpus);
const records = memories.map((m) => {
  const r = toMemoryRecord(m);
  r.metadata = { ...r.metadata, sessionDate: m.timestampIso };
  return r;
});
const filters = { tenantId: BENCH_TENANT, appId: BENCH_APP, actorId: BENCH_ACTOR };

async function run(opts: any): Promise<any[]> {
  const p: any = createMemoryProvider({ kind: "in-memory", ...opts });
  await p.ingest(records);
  const hits = await p.search({ query: corpus.question, filters, limit: RETRIEVAL_DEPTH, minScore: 0 });
  await p.close?.();
  return hits;
}

const problems: string[] = [];
const ids = (hits: any[]) => hits.map((h) => h.memory.id).join(",");

console.log(`question ${qid}, corpus ${records.length} turns\n`);

// --- BM25-only reference ---
const lexical = await run({ embedder: undefined });
const lexicalVectorCredits = lexical.filter((h) => h.reasons?.some((r: string) => /vector/i.test(r))).length;
console.log(`embedder=none        hits=${lexical.length} vectorCredits=${lexicalVectorCredits} reasons[0]=${JSON.stringify(lexical[0]?.reasons)}`);
if (lexicalVectorCredits !== 0) problems.push("embedder=none produced vector credits");

// --- hybrid via a ready shared instance, both rrfK values ---
const shared = getSharedEmbedder();
const k5 = await run({ embedder: shared, rrfK: 5 });
const k60 = await run({ embedder: shared, rrfK: 60 });

for (const [label, hits] of [["rrfK=5", k5], ["rrfK=60", k60]] as const) {
  const credits = hits.filter((h) => h.reasons?.some((r: string) => /vector/i.test(r))).length;
  const withComponent = hits.filter((h) => h.components?.vectorRank !== undefined).length;
  console.log(`${label.padEnd(20)} hits=${hits.length} vectorCredits=${credits} components.vectorRank=${withComponent} reasons[0]=${JSON.stringify(hits[0]?.reasons)}`);
  if (credits === 0) problems.push(`${label}: NO vector credit - silently degraded to BM25-only`);
}

// --- rrfK must actually matter ---
if (ids(k5) === ids(k60)) problems.push("rrfK=5 and rrfK=60 produced identical rankings - rrfK is not being applied");
else {
  const top10Same = ids(k5.slice(0, 10)) === ids(k60.slice(0, 10));
  console.log(`\nrrfK changes ranking: yes (top-10 identical? ${top10Same})`);
}

// --- the shortcut must be equivalent to the declarative spec ---
const viaSpec = await run({ embedderSpec: HYBRID_EMBEDDER_SPEC, rrfK: 5 });
if (ids(viaSpec) !== ids(k5)) {
  problems.push("embedderSpec route != shared-instance route: the caching shortcut changes results");
} else {
  console.log(`embedderSpec{kind:"local"} route == shared CachedEmbedder route: identical ranking (${viaSpec.length} hits)`);
}

console.log(`\n${problems.length === 0 ? "PASS: vector path live, rrfK applied, shortcut equivalent" : `FAIL (${problems.length}):`}`);
for (const p of problems) console.log(`  - ${p}`);
if (problems.length) process.exit(1);
