/**
 * Every path the TypeScript half of this harness uses, resolved from THIS file's
 * location so the scripts work from any cwd. Mirrors paths.py; the two must agree,
 * because Python and TypeScript stages read each other's files.
 *
 *   LOCOMO_DATA   the locomo10.json file      (default <harness>/data/locomo10.json)
 *   LOCOMO_WORK   intermediates, resumable    (default <harness>/work)
 *   LOCOMO_OUT    where reports are written   (default <harness>/out)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** bench/locomo */
export const HARNESS_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** The memory-core checkout this harness measures. */
export const REPO_ROOT = path.resolve(HARNESS_ROOT, "..", "..");

const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback;

export const DATA = env("LOCOMO_DATA", path.join(HARNESS_ROOT, "data", "locomo10.json"));
export const WORK = env("LOCOMO_WORK", path.join(HARNESS_ROOT, "work"));
export const OUT = env("LOCOMO_OUT", path.join(HARNESS_ROOT, "out"));

export const CORPUS = path.join(WORK, "corpus.json");
export const RANKINGS = path.join(WORK, "rankings");

/** Fail with one clear line instead of an ENOENT stack. */
export function requireCorpus(file = CORPUS): string {
  if (!fs.existsSync(file)) {
    throw new Error(
      `canonical corpus not found at ${file}\n` +
        `Build it first:  python3 build_corpus.py\n` +
        `Every system reads this one file, which is what makes the comparison ` +
        `same-corpus by construction. See DATA.md for the dataset itself.`,
    );
  }
  return file;
}

export function requireDir(dir: string, what: string, how: string): string {
  if (!fs.existsSync(dir)) throw new Error(`${what} not found at ${dir}\n${how}`);
  return dir;
}
