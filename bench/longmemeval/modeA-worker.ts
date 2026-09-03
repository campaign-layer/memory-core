/**
 * Mode A shard worker. Handles the questions where (index % shards === shard).
 * Appends one JSONL record per (question, system) and skips work already on disk,
 * so a shard that dies is resumed, not restarted.
 *
 * Loop order is QUESTION outer, SYSTEM inner. That is deliberate: the two hybrid
 * variants differ only in the RRF constant, so running them back to back on the
 * same corpus lets the shared CachedEmbedder serve the second one entirely from
 * cache instead of re-embedding ~500 turns.
 */
import fs from "node:fs";
import path from "node:path";
import { buildCorpus, listQuestionIds, loadQuestion, toMaterialized } from "./dataset.js";
import {
  datasetShaFromManifest, parseNonNegativeInteger, parseSubsetQuestionIds,
  parseSystemNames, rowMatchesRun, selectQuestionIds, type ModeARunIdentity,
} from "./integrity.js";
import { MANIFEST, MODE_A_DIR, requirePrepared } from "./paths.js";
import { repoShaAtRunTime } from "./provenance.js";
import {
  ALL_SYSTEMS, buildSystem, RETRIEVAL_DEPTH, type DiagSystem, type SearchDiag,
} from "./systems.js";

/** Resolved once, here, by the process that produces the rows. */
const REPO = repoShaAtRunTime();

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (fallback !== undefined) return fallback;
  console.error(
    `modeA-worker.ts is spawned by modeA.ts, not run directly.\n` +
      `Use ./run-modeA.sh, or npx tsx modeA.ts --help.\n\nerror: missing --${name}`,
  );
  process.exit(2);
}

function loadDone(file: string, run: ModeARunIdentity): Set<string> {
  const done = new Set<string>();
  if (!fs.existsSync(file)) return done;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      // A report tag names only the aggregate artifact; shard files are shared
      // across runs. Resume only rows produced by this exact code, checkout,
      // dataset and seed, or the cache can splice incompatible results.
      if (!row.error && rowMatchesRun(row, run)) done.add(row.qid);
    } catch {
      // A torn final line from a killed process. Ignore it; the qid is redone.
    }
  }
  return done;
}

async function main(): Promise<void> {
  requirePrepared();
  if (REPO.dirty) {
    throw new Error("LongMemEval Mode A requires a clean tracked worktree; commit the code before producing rows");
  }
  const shard = parseNonNegativeInteger(arg("shard"), "shard");
  const shards = parseNonNegativeInteger(arg("shards"), "shards");
  const seed = parseNonNegativeInteger(arg("seed", "1234"), "seed");
  const limit = parseNonNegativeInteger(arg("limit", "0"), "limit");
  if (shards === 0 || shard >= shards) throw new Error(`invalid shard ${shard} of ${shards}`);
  const subsetPath = arg("subset", "");
  const systemNames = parseSystemNames(arg("systems"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const run: ModeARunIdentity = {
    repoSha: REPO.sha,
    repoRoot: REPO.root,
    datasetSha: datasetShaFromManifest(manifest),
    seed,
  };

  const unknown = systemNames.filter((n) => !(ALL_SYSTEMS as readonly string[]).includes(n));
  if (unknown.length) {
    throw new Error(`unknown system(s): ${unknown.join(", ")}\nknown: ${ALL_SYSTEMS.join(", ")}`);
  }

  const subsetIds = subsetPath
    ? parseSubsetQuestionIds(JSON.parse(fs.readFileSync(subsetPath, "utf8")))
    : null;
  const selected = selectQuestionIds(listQuestionIds(), subsetIds, limit)
    .filter((_, i) => i % shards === shard);

  const outFile: Record<string, string> = {};
  const done: Record<string, Set<string>> = {};
  const systems: Record<string, DiagSystem> = {};
  for (const name of systemNames) {
    const dir = path.join(MODE_A_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    outFile[name] = path.join(dir, `shard-${shard}.jsonl`);
    done[name] = loadDone(outFile[name]!, run);
    systems[name] = buildSystem(name, seed);
  }

  const todoCount = systemNames.reduce((a, n) => a + selected.filter((q) => !done[n]!.has(q)).length, 0);
  console.log(`[shard ${shard}] ${selected.length} questions, ${todoCount} (question,system) pairs to do`);

  let processed = 0;
  for (const qid of selected) {
    const pending = systemNames.filter((n) => !done[n]!.has(qid));
    if (pending.length === 0) continue;

    const item = loadQuestion(qid);
    const corpus = buildCorpus(item);
    const memories = toMaterialized(corpus);

    for (const name of pending) {
      const sys = systems[name]!;
      let record: any;
      try {
        sys.diag = undefined;
        await sys.setup?.();
        const t0 = performance.now();
        await sys.ingest(memories);
        const t1 = performance.now();
        const ranking = await sys.search(corpus.question, RETRIEVAL_DEPTH);
        const t2 = performance.now();
        // The `sys.diag = undefined` reset above (which clears any stale diagnostic
        // from the previous question) narrows the property to `undefined` for the
        // rest of the block. search() assigns it, so re-widen to read what it set.
        const diag = sys.diag as SearchDiag | undefined;
        record = {
          qid,
          type: corpus.questionType,
          system: name,
          nCorpus: memories.length,
          nGold: corpus.goldIds.length,
          goldIds: corpus.goldIds,
          depth: RETRIEVAL_DEPTH,
          ranking: ranking.map((h) => [h.id, Number(h.score.toFixed(6))]),
          ingestMs: Number((t1 - t0).toFixed(2)),
          searchMs: Number((t2 - t1).toFixed(2)),
          // Provenance stamped by the process that produced this row, not by the scorer.
          repoSha: run.repoSha,
          repoRoot: run.repoRoot,
          datasetSha: run.datasetSha,
          seed: run.seed,
          note: sys.note,
          // Proof the vector leg ran, for the hybrid systems.
          vectorCredited: diag?.vectorCredited ?? null,
          storedVectors: diag?.storedVectors ?? null,
          sampleReasons: diag?.sampleReasons ?? null,
        };
      } catch (err: any) {
        const msg = String(err?.stack ?? err);
        // A liveness failure invalidates every row this system would produce, so it
        // kills the shard instead of quietly filling the file with error rows.
        if (msg.includes("LIVENESS")) {
          console.error(`[shard ${shard}] ABORT: ${msg}`);
          throw err;
        }
        record = {
          qid, type: corpus.questionType, system: name,
          nCorpus: memories.length, nGold: corpus.goldIds.length, goldIds: corpus.goldIds,
          depth: RETRIEVAL_DEPTH, ranking: [], ingestMs: 0, searchMs: 0,
          repoSha: run.repoSha, repoRoot: run.repoRoot,
          datasetSha: run.datasetSha, seed: run.seed,
          error: msg,
        };
      } finally {
        await sys.teardown?.();
      }
      fs.appendFileSync(outFile[name]!, `${JSON.stringify(record)}\n`);
    }

    if (++processed % 10 === 0) console.log(`[shard ${shard}] ${processed}/${selected.length} questions`);
  }
  console.log(`[shard ${shard}] done`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
