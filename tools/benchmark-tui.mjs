#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const longMemPath = path.join(root, "bench/longmemeval/results/modeA-fast.json");
const locomoPath = path.join(root, "bench/locomo/results/mode_a.json");
const syntheticPath = path.join(root, "bench/out/baseline-large.json");

function load(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
function bar(value, width = 30) {
  if (value == null) return "(not run)";
  const n = Math.max(0, Math.min(width, Math.round(value * width)));
  return "█".repeat(n) + "░".repeat(width - n);
}
function pct(value) { return value == null ? "  n/a" : `${(value * 100).toFixed(1).padStart(5)}%`; }
function row(name, value, baseline) {
  const delta = value == null || baseline == null ? "      —" : `${value - baseline >= 0 ? "+" : ""}${((value - baseline) * 100).toFixed(1).padStart(5)}pp`;
  return `${name.padEnd(20)} ${bar(value)} ${pct(value)}  ${delta}`;
}
function printSuite(title, systems, metric, baselineName = "memory-core") {
  const baseline = systems[baselineName] ?? null;
  console.log(`\n${title} · ${metric}   (delta vs ${baselineName})`);
  console.log("─".repeat(72));
  for (const [name, value] of Object.entries(systems)) console.log(row(name, value, baseline));
}

const long = load(longMemPath);
const locomo = load(locomoPath);
const synthetic = load(syntheticPath);
console.log("MEMORY CORE BENCHMARK TUI");
console.log(`commit ${process.env.MEMORY_CORE_BENCH_COMMIT || "working tree"}`);
console.log("Bars are normalized 0–100%; missing providers are not inferred.");

if (long?.systems) {
  const systems = Object.fromEntries(Object.entries(long.systems).map(([name, value]) => [
    name === "memory-core" ? "memory-core (hybrid)" : name,
    value.overall?.recallAt?.["10"] ?? null,
  ]));
  printSuite("LongMemEval-S (our harness, retrieval)", systems, "R@10", "memory-core (hybrid)");
  const mrr = Object.fromEntries(Object.entries(long.systems).map(([name, value]) => [
    name === "memory-core" ? "memory-core (hybrid)" : name, value.overall?.mrr ?? null,
  ]));
  printSuite("LongMemEval-S (our harness, retrieval)", mrr, "MRR", "memory-core (hybrid)");
} else console.log("\nLongMemEval-S: result artifact not found");

if (Array.isArray(locomo?.systems)) {
  const selected = new Set(["memory-core-hybrid-rrf5", "mem0", "bm25", "memory-core:in-memory", "random"]);
  const recall = Object.fromEntries(locomo.systems
    .filter((result) => selected.has(result.system))
    .map((result) => [result.system, result.overall?.recallAt?.["10"] ?? null]));
  printSuite("LoCoMo (same harness, retrieval)", recall, "R@10", "memory-core-hybrid-rrf5");
  const mrr = Object.fromEntries(locomo.systems
    .filter((result) => selected.has(result.system))
    .map((result) => [result.system, result.overall?.mrr ?? null]));
  printSuite("LoCoMo (same harness, retrieval)", mrr, "MRR", "memory-core-hybrid-rrf5");
} else console.log("\nLoCoMo: result artifact not found");

if (synthetic?.systems) {
  const systems = Object.fromEntries(Object.entries(synthetic.systems).map(([name, value]) => [
    value.system || name, value.metrics?.recallAt?.["10"] ?? value.overall?.recallAt?.["10"] ?? null,
  ]));
  printSuite("Synthetic MCIR (local, retrieval)", systems, "R@10", "in-memory");
} else console.log("\nSynthetic MCIR large: run `npm run bench:large` to populate the artifact");

console.log("\nPublished provider results · REFERENCE ONLY (different protocols)");
console.log("────────────────────────────────────────────────────────────────────────");
console.log(row("Mem0 managed LoCoMo", 0.925, null));
console.log(row("Mem0 managed LongMem", 0.944, null));
console.log(row("Supermemory LM R@15", 0.950, null));
console.log(row("Zep LoCoMo", 0.947, null));
console.log(row("Zep LongMemEval", 0.902, null));
console.log("Vendor bars mix QA and retrieval metrics and are never used for deltas.");
console.log("Use the same-harness LoCoMo panel for the defensible Mem0 comparison.");
console.log("Sources: docs.mem0.ai/core-concepts/memory-evaluation");
console.log("         supermemory.ai/research/longmembench · getzep.com/research");
