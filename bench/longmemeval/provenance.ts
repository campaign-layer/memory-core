import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { REPO_ROOT } from "./paths.js";

export interface Provenance {
  capturedAt: string;
  host: string;
  nodeVersion: string;
  repo: { root: string; sha: string; branch: string; dirty: boolean };
  dataset: { file: string; bytes: number; sha256: string };
  commandLine: string;
  cwd: string;
}

export function sha256File(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1 << 22);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

function git(args: string[]): string {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * The SHA of the code that is about to RUN, resolved by the worker itself.
 *
 * Stamping the SHA at scoring time instead of run time is how a neighbouring run
 * got spliced across two commits while its provenance still looked consistent: the
 * checkout moved mid-run and only the final report was stamped. Every result row
 * carries this, and the aggregator includes it in the complete run identity.
 */
export function repoShaAtRunTime(): { sha: string; root: string; dirty: boolean } {
  return {
    sha: git(["rev-parse", "HEAD"]),
    root: REPO_ROOT,
    // Benchmark outputs and third-party datasets are intentionally untracked.
    // Only tracked changes mean the executable code differs from HEAD.
    dirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0,
  };
}

export function captureProvenance(datasetFile: string, datasetSha?: string): Provenance {
  const stat = fs.statSync(datasetFile);
  return {
    capturedAt: new Date().toISOString(),
    host: os.hostname(),
    nodeVersion: process.version,
    repo: {
      root: REPO_ROOT,
      sha: git(["rev-parse", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
      dirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0,
    },
    dataset: {
      file: datasetFile,
      bytes: stat.size,
      sha256: datasetSha ?? sha256File(datasetFile),
    },
    commandLine: [process.argv0, ...process.argv.slice(1)].join(" "),
    cwd: process.cwd(),
  };
}
