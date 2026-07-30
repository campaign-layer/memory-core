/**
 * Writes a deterministic, question_type-stratified subset of question ids.
 *
 * Needed because memory-core-hybrid embeds every turn with a real ONNX sentence
 * encoder (~250 core-seconds per question), so a full 500-question run would hold
 * ~28 of this shared box's 32 cores for 4-5 hours. The subset is scored for EVERY
 * system, so the hybrid comparison stays same-harness and same-questions.
 *
 *   npx tsx subset.ts --n=150 --out=work/subset-150.json
 */
import fs from "node:fs";
import { MANIFEST, requirePrepared } from "./paths.js";

function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const n = Number(arg("n", "150"));
const out = arg("out", "");
if (!out) {
  console.error("usage: npx tsx subset.ts [--n=150] --out=<file.json>");
  console.error("  writes a deterministic, question_type-stratified list of question ids");
  process.exit(2);
}

requirePrepared();
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const per: Array<{ questionId: string; questionType: string; nGold: number }> = manifest.perQuestion;

const byType = new Map<string, string[]>();
for (const q of per) {
  if (!byType.has(q.questionType)) byType.set(q.questionType, []);
  byType.get(q.questionType)!.push(q.questionId);
}

// Proportional quota per type, then an even stride through the sorted ids so the
// pick is reproducible and not just an alphabetical prefix.
const picked: string[] = [];
for (const [, ids] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const sorted = ids.slice().sort();
  const quota = Math.max(1, Math.round((n * sorted.length) / per.length));
  const step = Math.max(1, sorted.length / quota);
  for (let i = 0, taken = 0; taken < quota && Math.floor(i) < sorted.length; i += step, taken++) {
    picked.push(sorted[Math.floor(i)]!);
  }
}

const unique = [...new Set(picked)].sort();
fs.writeFileSync(out, JSON.stringify(unique, null, 1));

const counts: Record<string, number> = {};
const typeOf = new Map(per.map((q) => [q.questionId, q.questionType]));
const goldOf = new Map(per.map((q) => [q.questionId, q.nGold]));
for (const q of unique) counts[typeOf.get(q)!] = (counts[typeOf.get(q)!] ?? 0) + 1;

console.log(`wrote ${unique.length} question ids to ${out}`);
console.log(`byType: ${JSON.stringify(counts)}`);
console.log(`zero-gold in subset (excluded from retrieval metrics): ${unique.filter((q) => goldOf.get(q) === 0).length}`);
