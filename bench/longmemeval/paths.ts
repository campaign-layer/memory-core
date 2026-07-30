/**
 * Every path this harness uses, resolved from THIS file's location so that shard
 * workers can be spawned from any cwd and nothing depends on where the repo lives.
 * All of them are overridable by env var:
 *
 *   LME_DATA_DIR   where the downloaded dataset lives   (default <harness>/data)
 *   LME_DATASET    the LongMemEval_S file itself        (default <data>/longmemeval_s.json)
 *   LME_WORK_DIR   split files + manifest, ~300 MB      (default <harness>/work)
 *   LME_OUT_DIR    where reports are written            (default <harness>/out)
 *   LME_TSX        tsx binary used to spawn workers     (default: first one found)
 *
 * See DATA.md for how to obtain the dataset. `out/` is gitignored; the committed
 * evidence behind the published tables lives in `results/` and is never written to.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** bench/longmemeval */
export const HARNESS_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** The memory-core checkout this harness measures. */
export const REPO_ROOT = path.resolve(HARNESS_ROOT, "..", "..");

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export const DATA_DIR = env("LME_DATA_DIR", path.join(HARNESS_ROOT, "data"));
export const WORK_DIR = env("LME_WORK_DIR", path.join(HARNESS_ROOT, "work"));
export const SPLIT_DIR = path.join(WORK_DIR, "split");
export const RESULTS_DIR = env("LME_OUT_DIR", path.join(HARNESS_ROOT, "out"));
export const MODE_A_DIR = path.join(RESULTS_DIR, "modeA");
export const MODE_B_DIR = path.join(RESULTS_DIR, "modeB");

export const DATASET_S = env("LME_DATASET", path.join(DATA_DIR, "longmemeval_s.json"));
export const MANIFEST = path.join(WORK_DIR, "manifest.json");

/**
 * tsx is resolved, not hardcoded: this harness has its own package.json, but a
 * repo-root install works too. Spawned workers must run under the SAME node as the
 * orchestrator, so modeA.ts uses process.execPath with this script path.
 */
export function resolveTsx(): string {
  const candidates = [
    process.env.LME_TSX?.trim(),
    path.join(HARNESS_ROOT, "node_modules", ".bin", "tsx"),
    path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
  ].filter((x): x is string => !!x);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return fail(
    `tsx not found. Run \`npm install\` in ${HARNESS_ROOT} (or in the repo root),\n` +
      `       or set LME_TSX to a tsx binary. Looked in:\n         ${candidates.join("\n         ")}`,
  );
}

/**
 * A missing prerequisite is a user error, not a crash. Print the fix and exit, so the
 * first thing a reader sees is what to do rather than a stack frame in paths.ts.
 */
function fail(message: string): never {
  console.error(`\nerror: ${message}\n`);
  process.exit(1);
}

/** Fail with one clear line instead of an ENOENT deep inside a shard worker. */
export function requireDataset(): string {
  if (!fs.existsSync(DATASET_S)) {
    fail(
      `LongMemEval_S not found at ${DATASET_S}\n` +
        `       It is a 278 MB third-party dataset and is deliberately not committed to this repo.\n` +
        `       See ${path.join(HARNESS_ROOT, "DATA.md")} for the download command and expected sha256,\n` +
        `       or point LME_DATASET at an existing copy.`,
    );
  }
  return DATASET_S;
}

/** Every stage after prepare.ts reads the split corpus, not the 278 MB original. */
export function requirePrepared(): void {
  if (!fs.existsSync(MANIFEST)) {
    fail(
      `dataset not prepared: no manifest at ${MANIFEST}\n` +
        `       Run the one-time dataset split first:\n` +
        `         node --max-old-space-size=8192 node_modules/.bin/tsx prepare.ts\n` +
        `       or just ./run-modeA.sh, which does it for you.\n` +
        `       If you have not downloaded the dataset yet, start with DATA.md.`,
    );
  }
}

/** Mode B consumes Mode A's rankings; say so rather than reporting an empty table. */
export function requireModeA(system: string): string {
  const dir = path.join(MODE_A_DIR, system);
  if (!fs.existsSync(dir)) {
    fail(
      `no Mode A results for system "${system}" at ${dir}\n` +
        `       Mode B scores the retrieval Mode A produced. Run ./run-modeA.sh first.`,
    );
  }
  return dir;
}
