#!/usr/bin/env node
/**
 * Dataset CLI.
 *   npx tsx bench/dataset/generate.ts --size=small --seed=1337
 *   npx tsx bench/dataset/generate.ts --size=large --seed=1337 --out=bench/dataset/generated
 *
 * Output is byte-identical for a given (size, seed).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDataset, validateDataset } from "./spec.js";
import type { Dataset, MaterializedMemory } from "../types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GENERATED_DIR = path.join(HERE, "generated");

export function datasetFilename(size: "small" | "large", seed: number): string {
  return `${size}-seed${seed}.json`;
}

export function datasetHash(dataset: Dataset): string {
  return createHash("sha256").update(serialize(dataset)).digest("hex").slice(0, 16);
}

function serialize(dataset: Dataset): string {
  return `${JSON.stringify(dataset, null, 2)}\n`;
}

export function writeDataset(dataset: Dataset, dir = GENERATED_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, datasetFilename(dataset.meta.size, dataset.meta.seed));
  writeFileSync(file, serialize(dataset), "utf8");
  return file;
}

/** Loads from disk, generating and persisting the fixture if it is not there yet. */
export function loadOrCreateDataset(size: "small" | "large", seed: number, dir = GENERATED_DIR): { dataset: Dataset; file: string } {
  const file = path.join(dir, datasetFilename(size, seed));
  if (existsSync(file)) {
    const dataset = JSON.parse(readFileSync(file, "utf8")) as Dataset;
    validateDataset(dataset);
    return { dataset, file };
  }
  const dataset = generateDataset({ size, seed });
  return { dataset, file: writeDataset(dataset, dir) };
}

/**
 * Resolves relative dayOffset/minuteOfDay into absolute ISO timestamps.
 *
 * Every timestamp lands STRICTLY BEFORE the anchor. That matters: src/utils.ts
 * recencyScore() does Math.max(ageDays, 0), so a future timestamp pins recency at
 * exactly 1.0 and then drifts off that clamp as the wall clock advances — which moved
 * in-memory's recall@1 by 5.7 points over one day before this was fixed.
 * Larger minuteOfDay still means later, so intra-session ordering is preserved.
 */
export function materialize(dataset: Dataset, anchorIso: string): MaterializedMemory[] {
  const anchorMs = new Date(anchorIso).getTime();
  return dataset.memories.map((m) => ({
    ...m,
    timestampIso: new Date(
      anchorMs - m.dayOffset * 86400000 - (1440 - m.minuteOfDay) * 60000,
    ).toISOString(),
  }));
}

export function defaultTimeAnchor(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const size = (arg("size", "small") as "small" | "large");
  if (size !== "small" && size !== "large") throw new Error(`--size must be small|large, got ${size}`);
  const seed = Number(arg("seed", "1337"));
  const dir = arg("out") ? path.resolve(arg("out")!) : GENERATED_DIR;

  const dataset = generateDataset({ size, seed });
  const file = writeDataset(dataset, dir);

  console.log(`dataset: ${dataset.meta.name} v${dataset.meta.version}`);
  console.log(`size=${size} seed=${seed} hash=${datasetHash(dataset)}`);
  console.log(`items=${dataset.meta.counts.items} memories=${dataset.meta.counts.memories} sessions=${dataset.meta.counts.sessions}`);
  console.log(`by family: ${JSON.stringify(dataset.meta.counts.byFamily)}`);
  console.log(`by role:   ${JSON.stringify(dataset.meta.counts.byRole)}`);
  console.log(`wrote ${file}`);
}
