/**
 * Mode A orchestrator: fan out shard workers, wait, aggregate.
 *   tsx modeA.ts --shards=12 --systems=bm25,memory-core,random [--limit=10] [--tag=smoke]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_ROOT, MODE_A_DIR, requirePrepared, resolveTsx } from "./paths.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = [
  "LongMemEval Mode A orchestrator (retrieval only, no API key).",
  "",
  "  npx tsx modeA.ts --systems=bm25,memory-core,random [options]",
  "",
  "  --systems=a,b,c   required. Any of:",
  "                    bm25, memory-core, memory-core-hybrid-k5,",
  "                    memory-core-hybrid-k60, random, mc-enhanced, mc-dual-layer",
  "  --shards=N        parallel shard workers (default 12)",
  "  --tag=NAME        report name -> out/modeA-<tag>.{json,md} (default full)",
  "  --limit=N         only the first N questions (smoke tests)",
  "  --subset=FILE     restrict to a question-id list from subset.ts",
  "  --seed=N          random-control seed (default 1234)",
  "",
  "Prefer ./run-modeA.sh, which prepares the dataset split first.",
].join("\n");

function arg(name: string, fallback?: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback !== undefined) return fallback;
  console.error(`${USAGE}\n\nerror: missing --${name}`);
  process.exit(2);
}

/**
 * Always spawns THIS node. Invoking node_modules/.bin/tsx directly would follow its
 * `#!/usr/bin/env node` shebang, which may resolve to an older node than the one
 * running the orchestrator.
 */
function run(tsx: string, script: string, args: string[], label: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [tsx, script, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: HARNESS_ROOT,
    });
    p.stdout.on("data", (d) => process.stdout.write(`${d}`));
    p.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    p.on("close", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  requirePrepared();
  const TSX = resolveTsx();
  const shards = Number(arg("shards", "12"));
  const systems = arg("systems");
  const limit = arg("limit", "0");
  const seed = arg("seed", "1234");
  const tag = arg("tag", "full");
  const subset = arg("subset", "");

  fs.mkdirSync(MODE_A_DIR, { recursive: true });
  const t0 = Date.now();
  console.log(`Mode A: shards=${shards} systems=${systems} limit=${limit} tag=${tag}`);

  const jobs: Array<Promise<number>> = [];
  for (let i = 0; i < shards; i++) {
    jobs.push(run(TSX, path.join(HERE, "modeA-worker.ts"), [
      `--shard=${i}`, `--shards=${shards}`, `--systems=${systems}`, `--limit=${limit}`, `--seed=${seed}`, `--subset=${subset}`,
    ], `shard ${i}`));
  }
  const codes = await Promise.all(jobs);
  const failed = codes.filter((c) => c !== 0).length;
  console.log(`\nshards finished in ${((Date.now() - t0) / 1000).toFixed(1)}s; ${failed} failed`);
  if (failed > 0) console.log(`WARNING: ${failed} shard(s) exited non-zero - rerun the same command to resume`);

  const code = await run(TSX, path.join(HERE, "aggregate.ts"), [`--systems=${systems}`, `--tag=${tag}`, `--subset=${subset}`], "aggregate");
  console.log(`\nMode A wall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(code);
}

main().catch((err) => {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
});
