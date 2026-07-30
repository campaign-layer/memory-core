/**
 * Integrity check: prove that nothing the ranker sees encodes the gold label or
 * the gold answer beyond what the raw dataset turn already says.
 * This repo previously "scored" on LongMemEval by hardcoding answers, so this is
 * verified per run rather than assumed.
 */
import { buildCorpus, listQuestionIds, loadQuestion, toMaterialized } from "./dataset.js";
import { toMemoryRecord } from "../types.js";
import { requirePrepared } from "./paths.js";

requirePrepared();
const ids = listQuestionIds();
let checked = 0, goldTurns = 0;
const problems: string[] = [];

for (const qid of ids) {
  const item = loadQuestion(qid);
  const corpus = buildCorpus(item);
  const mats = toMaterialized(corpus);
  const answer = String(item.answer ?? "").trim();

  // 1. indexed text must be byte-exact `role: content` from the source file.
  corpus.turns.forEach((t) => {
    const src = item.haystack_sessions[t.sessionIndex]![t.turnIndex]!;
    if (t.text !== `${src.role}: ${src.content ?? ""}`) problems.push(`${qid} ${t.id}: text != role+content`);
  });

  // 2. no label channel: role/confidence/importance/memoryType must be constant.
  const roles = new Set(mats.map((m) => m.role));
  const confs = new Set(mats.map((m) => m.confidence));
  const imps = new Set(mats.map((m) => m.importance));
  const types = new Set(mats.map((m) => m.memoryType));
  if (roles.size > 1 || confs.size > 1 || imps.size > 1 || types.size > 1) {
    problems.push(`${qid}: non-constant ranking feature (roles=${roles.size} conf=${confs.size} imp=${imps.size} type=${types.size})`);
  }

  // 3. the record handed to the provider must carry no gold marker anywhere.
  for (const m of mats) {
    const rec = toMemoryRecord(m);
    rec.metadata = { ...rec.metadata, sessionDate: m.timestampIso };
    const blob = JSON.stringify(rec);
    if (/has_answer|isGold|"gold"|answer_session/i.test(blob)) problems.push(`${qid} ${m.id}: gold marker in record`);
    const keys = Object.keys(rec.metadata).sort().join(",");
    if (keys !== "sessionDate,sessionId,sessionIndex") problems.push(`${qid} ${m.id}: unexpected metadata keys ${keys}`);
  }

  // 4. the answer string must appear ONLY inside real turn content, never injected.
  if (answer.length > 12) {
    const carriers = corpus.turns.filter((t) => t.text.includes(answer));
    for (const c of carriers) {
      const src = item.haystack_sessions[c.sessionIndex]![c.turnIndex]!;
      if (!(src.content ?? "").includes(answer)) problems.push(`${qid} ${c.id}: answer present but not in source content`);
    }
  }
  goldTurns += corpus.goldIds.length;
  checked++;
}

console.log(`questions checked: ${checked}, gold turns: ${goldTurns}`);
console.log(problems.length === 0 ? "PASS: no gold label or injected answer reaches the ranker" : `FAIL (${problems.length}):`);
for (const p of problems.slice(0, 20)) console.log("  " + p);
// Exit non-zero so this can gate a run rather than only inform one.
if (problems.length) process.exit(1);
