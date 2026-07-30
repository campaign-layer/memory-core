/**
 * One-time: split longmemeval_s.json (278 MB) into one file per question and
 * record a manifest. Every later stage reads only the per-question files, so no
 * worker ever holds the whole dataset in memory.
 *
 * Run with a raised heap: node --max-old-space-size=8192.
 */
import fs from "node:fs";
import path from "node:path";
import { buildCorpus, parseLmeDate, type LmeQuestion } from "./dataset.js";
import { DATASET_S, MANIFEST, requireDataset, SPLIT_DIR, WORK_DIR } from "./paths.js";
import { captureProvenance, sha256File } from "./provenance.js";

function main(): void {
  requireDataset();
  fs.mkdirSync(SPLIT_DIR, { recursive: true });

  console.log(`hashing ${DATASET_S} ...`);
  const sha = sha256File(DATASET_S);
  console.log(`sha256=${sha}`);

  console.log("parsing dataset (this needs a few GB of heap) ...");
  const items = JSON.parse(fs.readFileSync(DATASET_S, "utf8")) as LmeQuestion[];
  console.log(`parsed ${items.length} questions`);

  const perQuestion: any[] = [];
  const byType: Record<string, number> = {};
  const zeroGold: string[] = [];
  const dateFailures: Array<{ questionId: string; raw: string; error: string }> = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.question_id)) throw new Error(`duplicate question_id ${item.question_id}`);
    seen.add(item.question_id);

    // Fail loud here, once, rather than inside 12 parallel workers later.
    try {
      for (const d of item.haystack_dates) parseLmeDate(d);
    } catch (err: any) {
      dateFailures.push({ questionId: item.question_id, raw: String(item.haystack_dates?.[0]), error: String(err?.message ?? err) });
    }

    const corpus = buildCorpus(item);
    byType[item.question_type] = (byType[item.question_type] ?? 0) + 1;
    if (corpus.goldIds.length === 0) zeroGold.push(item.question_id);

    perQuestion.push({
      questionId: item.question_id,
      questionType: item.question_type,
      nSessions: item.haystack_sessions.length,
      nTurns: corpus.turns.length,
      nGold: corpus.goldIds.length,
      chars: corpus.turns.reduce((a, t) => a + t.text.length, 0),
      answerChars: (item.answer ?? "").length,
    });

    fs.writeFileSync(path.join(SPLIT_DIR, `${item.question_id}.json`), JSON.stringify(item));
  }

  const totalGold = perQuestion.reduce((a, q) => a + q.nGold, 0);
  const goldCounts = perQuestion.map((q) => q.nGold).sort((a, b) => a - b);
  const turnCounts = perQuestion.map((q) => q.nTurns).sort((a, b) => a - b);
  const p50 = (xs: number[]) => xs[Math.floor(xs.length / 2)];

  const manifest = {
    provenance: captureProvenance(DATASET_S, sha),
    counts: {
      questions: items.length,
      byType,
      totalGoldTurns: totalGold,
      goldPerQuestionP50: p50(goldCounts),
      turnsPerQuestionMean: turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length,
      turnsPerQuestionP50: p50(turnCounts),
      meanCorpusSize: turnCounts.reduce((a, b) => a + b, 0) / turnCounts.length,
    },
    /** Excluded from ALL retrieval scoring. Reported, never silently dropped. */
    zeroGoldQuestionIds: zeroGold,
    dateFailures,
    perQuestion,
  };

  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));

  console.log(`wrote ${items.length} split files to ${SPLIT_DIR}`);
  console.log(`manifest: ${MANIFEST}`);
  console.log(`byType: ${JSON.stringify(byType)}`);
  console.log(`total gold turns: ${totalGold}; gold/question p50=${p50(goldCounts)}`);
  console.log(`mean corpus size (turns): ${manifest.counts.meanCorpusSize.toFixed(1)}`);
  console.log(`ZERO-GOLD questions (excluded from retrieval scoring): ${zeroGold.length}`);
  console.log(zeroGold.join(" "));
  if (dateFailures.length) console.log(`DATE FAILURES: ${JSON.stringify(dateFailures)}`);
}

try {
  main();
} catch (err: any) {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
}
