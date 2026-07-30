/**
 * Turns Mode A JSONL shards into metrics. Metric implementations come from
 * memory-core/bench/metrics.ts (recall@k with partial credit, MRR, nDCG@10,
 * mean rank, analytic random baseline) so the harness does not define its own.
 */
import fs from "node:fs";
import path from "node:path";
import {
  analyticRandomBaseline, computeRankMetrics,
  type QueryOutcome, type RankMetrics,
} from "../metrics.js";
import type { EvalItem } from "../types.js";
import { MANIFEST, MODE_A_DIR, RESULTS_DIR, DATASET_S, requirePrepared } from "./paths.js";
import { captureProvenance } from "./provenance.js";
import { RETRIEVAL_DEPTH, retrievalConfigLabel } from "./systems.js";

const KS = [1, 5, 10, 30] as const;

const TYPE_ORDER = [
  "temporal-reasoning", "multi-session", "knowledge-update",
  "single-session-user", "single-session-assistant", "single-session-preference",
];

interface Row {
  qid: string; type: string; system: string;
  nCorpus: number; nGold: number; goldIds: string[];
  ranking: Array<[string, number]>;
  ingestMs: number; searchMs: number; error?: string;
  repoSha?: string; repoRoot?: string; note?: string;
  vectorCredited?: number | null; storedVectors?: number | null; sampleReasons?: string[] | null;
}

/**
 * Dedupes by qid. Necessary because resuming with a different --shards value
 * reassigns questions to shards, so the same qid can land in two shard files and
 * would otherwise be counted twice.
 */
function readSystem(system: string): Row[] {
  const dir = path.join(MODE_A_DIR, system);
  if (!fs.existsSync(dir)) return [];
  const byQid = new Map<string, Row>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Row;
        // Prefer a successful row over an errored duplicate.
        const prev = byQid.get(row.qid);
        if (!prev || (prev.error && !row.error)) byQid.set(row.qid, row);
      } catch {
        // torn line from a killed shard
      }
    }
  }
  return [...byQid.values()];
}

function toItemsAndOutcomes(rows: Row[]) {
  const items: EvalItem[] = [];
  const outcomes = new Map<string, QueryOutcome>();
  for (const r of rows) {
    items.push({ id: r.qid, family: r.type as any, query: "", goldMemoryIds: r.goldIds });
    outcomes.set(r.qid, {
      itemId: r.qid,
      family: r.type as any,
      ranking: r.ranking.map(([id, score]) => ({ id, score })),
      latencyMs: r.searchMs,
      error: r.error,
    });
  }
  return { items, outcomes };
}

function fmt(x: number | undefined, digits = 4): string {
  return x === undefined || Number.isNaN(x) ? "-" : x.toFixed(digits);
}

function metricsRow(label: string, m: RankMetrics): string {
  return `| ${label} | ${m.n} | ${fmt(m.recallAt[1])} | ${fmt(m.recallAt[5])} | ${fmt(m.recallAt[10])} | ${fmt(m.recallAt[30])} | ${fmt(m.mrr)} | ${fmt(m.ndcgAt10)} | ${fmt(m.meanRank, 1)} | ${fmt(m.foundRate)} |`;
}

/**
 * The cross-system table carries the retrieval CONFIG next to the system name, not
 * just the name. A row reading "memory-core" alone has been mistaken for the hybrid
 * configuration before; "memory-core (BM25-only)" cannot be.
 */
function systemRow(system: string, m: RankMetrics): string {
  return metricsRow(`${system} — ${retrievalConfigLabel(system)}`, m);
}

const HEADER = "| slice | n | R@1 | R@5 | R@10 | R@30 | MRR | nDCG@10 | meanRank | found@100 |";
const SEP = "|---|---|---|---|---|---|---|---|---|---|";

function jaccardTop10(a: Row[], b: Row[]): number {
  const bi = new Map(b.map((r) => [r.qid, r]));
  const vals: number[] = [];
  for (const ra of a) {
    const rb = bi.get(ra.qid);
    if (!rb) continue;
    const sa = new Set(ra.ranking.slice(0, 10).map((x) => x[0]));
    const sb = new Set(rb.ranking.slice(0, 10).map((x) => x[0]));
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter++;
    const uni = new Set([...sa, ...sb]).size;
    vals.push(uni === 0 ? 1 : inter / uni);
  }
  return vals.length ? vals.reduce((p, q) => p + q, 0) / vals.length : NaN;
}

/** Off-by-one here silently renamed a system and dropped it from the report. Keep it central. */
function arg(name: string, fallback?: string): string {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (fallback !== undefined) return fallback;
  console.error(
    "usage: npx tsx aggregate.ts --systems=a,b,c [--tag=NAME] [--subset=FILE]\n" +
      "  Re-scores Mode A JSONL shards already on disk. modeA.ts runs this for you.\n" +
      `\nerror: missing --${name}`,
  );
  process.exit(2);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: npx tsx aggregate.ts --systems=a,b,c [--tag=NAME] [--subset=FILE]");
    return;
  }
  requirePrepared();
  const systems = arg("systems").split(",").filter(Boolean);
  const tag = arg("tag", "run");
  const subsetPath = arg("subset", "");

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  let zeroGold: string[] = manifest.zeroGoldQuestionIds;

  // Restricting every system to one id set is what keeps a subsampled system
  // comparable to the rest: same questions, same corpora, same metrics.
  let subset: Set<string> | null = null;
  if (subsetPath) {
    subset = new Set<string>(JSON.parse(fs.readFileSync(subsetPath, "utf8")));
    zeroGold = zeroGold.filter((q) => subset!.has(q));
  }

  const raw: Record<string, Row[]> = {};
  for (const s of systems) {
    const rows = readSystem(s);
    raw[s] = subset ? rows.filter((r) => subset!.has(r.qid)) : rows;
  }

  const report: any = {
    mode: "A-retrieval-only",
    tag,
    subset: subsetPath ? { file: subsetPath, size: subset!.size } : null,
    provenance: captureProvenance(DATASET_S, manifest.provenance?.dataset?.sha256),
    protocol: {
      corpus: "one memory per haystack turn, text = `${role}: ${content}`; one fresh corpus per question",
      sessionDate: "haystack_dates[sessionIndex] -> record firstSeenAt/lastSeenAt/createdAt AND metadata.sessionDate",
      query: "the question string verbatim; question_date is NOT appended (Mode B gives it to the reader instead)",
      gold: "turns with has_answer === true",
      retrievalDepth: RETRIEVAL_DEPTH,
      ks: KS,
      minScore: 0,
      uniformFields: "memoryType=episode, confidence=0.8, importance=0.5 for every turn, so no label can leak via ranking features",
      missPenalty: "unretrieved gold is charged meanCorpusSize+1 in meanRank (bench/metrics.ts convention)",
    },
    exclusions: {
      zeroGoldCount: zeroGold.length,
      zeroGoldQuestionIds: zeroGold,
      note: "questions with no has_answer turn have no retrieval target; excluded from every retrieval metric, reported not dropped",
    },
    systems: {} as Record<string, any>,
  };

  const lines: string[] = [];
  lines.push(`# LongMemEval Mode A (retrieval only) - memory-core internal harness`);
  lines.push("");
  lines.push(`Repo ${report.provenance.repo.sha.slice(0, 7)} (${report.provenance.repo.branch}), node ${report.provenance.nodeVersion}, dataset sha256 ${report.provenance.dataset.sha256.slice(0, 16)}...`);
  if (subsetPath) lines.push(`\nRestricted to the ${subset!.size}-question stratified subset \`${subsetPath}\`. Every system below is scored on these same questions.`);
  lines.push("");

  const overallBySystem: Record<string, RankMetrics> = {};

  for (const system of systems) {
    const rows = raw[system]!;
    if (rows.length === 0) {
      report.systems[system] = { status: "missing", note: "no result rows on disk" };
      continue;
    }

    const scored = rows.filter((r) => r.nGold > 0);
    const meanCorpus = Math.round(scored.reduce((a, r) => a + r.nCorpus, 0) / Math.max(1, scored.length));
    const { items, outcomes } = toItemsAndOutcomes(rows);

    const overall = computeRankMetrics("overall", items, outcomes, meanCorpus, KS);
    overallBySystem[system] = overall;

    const perType: Record<string, RankMetrics> = {};
    for (const t of TYPE_ORDER) {
      const sub = items.filter((i) => (i.family as string) === t);
      if (sub.length === 0) continue;
      perType[t] = computeRankMetrics(t, sub, outcomes, meanCorpus, KS);
    }

    const analytic = analyticRandomBaseline(items, meanCorpus, KS, RETRIEVAL_DEPTH);

    // Provenance is taken from the ROWS, not from the working tree at scoring time.
    const shas = [...new Set(rows.map((r) => r.repoSha ?? "unstamped"))].sort();
    const roots = [...new Set(rows.map((r) => r.repoRoot ?? "unknown"))].sort();
    const vectorRows = rows.filter((r) => typeof r.vectorCredited === "number");
    const vectorLiveness = vectorRows.length
      ? {
          rowsWithDiag: vectorRows.length,
          questionsWithZeroVectorCredit: vectorRows.filter((r) => (r.vectorCredited ?? 0) === 0).length,
          meanVectorCreditedHits: vectorRows.reduce((a, r) => a + (r.vectorCredited ?? 0), 0) / vectorRows.length,
          meanVectorCreditedFraction:
            vectorRows.reduce((a, r) => a + (r.vectorCredited ?? 0) / Math.max(1, r.ranking.length), 0) / vectorRows.length,
          fullyEmbeddedQuestions: vectorRows.filter((r) => (r.storedVectors ?? 0) >= r.nCorpus).length,
          sampleReasons: vectorRows.find((r) => (r.sampleReasons ?? []).length)?.sampleReasons ?? null,
        }
      : null;

    report.systems[system] = {
      status: "ok",
      runTimeProvenance: { repoShas: shas, repoRoots: roots, mixed: shas.length > 1, note: rows[0]?.note ?? null },
      vectorLiveness,
      questionsRun: rows.length,
      questionsScored: scored.length,
      questionsExcludedZeroGold: rows.length - scored.length,
      meanCorpusSize: meanCorpus,
      errors: rows.filter((r) => r.error).length,
      errorSamples: rows.filter((r) => r.error).slice(0, 3).map((r) => ({ qid: r.qid, error: r.error!.slice(0, 400) })),
      ingestMsMean: rows.reduce((a, r) => a + r.ingestMs, 0) / rows.length,
      searchMsMean: rows.reduce((a, r) => a + r.searchMs, 0) / rows.length,
      // A system returning far fewer than `depth` hits is being cut off by its own
      // gate/candidate pool, which caps recall for reasons unrelated to ranking.
      rankingLen: {
        mean: rows.reduce((a, r) => a + r.ranking.length, 0) / rows.length,
        min: Math.min(...rows.map((r) => r.ranking.length)),
        max: Math.max(...rows.map((r) => r.ranking.length)),
      },
      overall,
      perType,
      analyticRandomBaseline: analytic,
    };

    const rl = report.systems[system].rankingLen;
    lines.push(`## ${system} — ${retrievalConfigLabel(system)}`);
    lines.push(`n scored = ${scored.length} (of ${rows.length} run; ${rows.length - scored.length} zero-gold excluded), mean corpus = ${meanCorpus} turns, errors = ${rows.filter((r) => r.error).length}, hits returned mean/min/max = ${rl.mean.toFixed(1)}/${rl.min}/${rl.max} of depth ${RETRIEVAL_DEPTH}`);
    lines.push("");
    lines.push(HEADER);
    lines.push(SEP);
    for (const t of TYPE_ORDER) if (perType[t]) lines.push(metricsRow(t, perType[t]!));
    lines.push(metricsRow("**overall**", overall));
    lines.push("");
    lines.push(`Analytic random floor on the same corpora: R@1=${fmt(analytic.recallAt[1])} R@5=${fmt(analytic.recallAt[5])} R@10=${fmt(analytic.recallAt[10])} R@30=${fmt(analytic.recallAt[30])} MRR=${fmt(analytic.mrr)} meanRank=${fmt(analytic.meanRank, 1)}`);
    lines.push("");
  }

  // Headline cross-system table. Same run, same corpora, same metric definitions.
  lines.push("## Overall, all systems (same harness, same corpora)");
  lines.push("");
  lines.push(
    `Every row below was scored on the SAME ${subsetPath ? `${subset!.size}-question subset` : "question set"} ` +
      `with the same metric definitions. Rows from a DIFFERENT tag have a different denominator and must not be ` +
      `combined with these. The retrieval configuration is printed with each system name because "memory-core" ` +
      `alone does not say whether an embedder was used.`,
  );
  lines.push("");
  lines.push(HEADER);
  lines.push(SEP);
  for (const system of systems) {
    const m = overallBySystem[system];
    if (m) lines.push(systemRow(system, m));
  }
  lines.push("");

  // Sanity block: the checks that would catch a broken or leaking harness.
  const sanity: any = { flags: [] as string[] };
  if (overallBySystem["random"] && report.systems["random"]) {
    const emp = overallBySystem["random"]!.recallAt[10]!;
    const ana = report.systems["random"].analyticRandomBaseline.recallAt[10]!;
    const n = overallBySystem["random"]!.n;
    // Sample-size aware: recall@10 under chance is ~2%, so at small n a run of
    // zeros is ordinary sampling noise, not a bug. 3 sigma + a small floor.
    const tol = Math.max(0.01, 3 * Math.sqrt(Math.max(ana * (1 - ana), 1e-6) / Math.max(1, n)));
    sanity.randomEmpiricalRecallAt10 = emp;
    sanity.randomAnalyticRecallAt10 = ana;
    sanity.randomTolerance3Sigma = tol;
    sanity.randomControlOk = Math.abs(emp - ana) <= tol;
    if (!sanity.randomControlOk) sanity.flags.push(`random control (${emp.toFixed(4)}) outside 3 sigma of analytic floor (${ana.toFixed(4)} +/- ${tol.toFixed(4)}, n=${n}) - harness bug suspected`);
  }
  // Hard provenance gate: mixed SHAs mean the numbers are spliced across commits.
  sanity.runTimeShas = {};
  for (const system of systems) {
    const p = report.systems[system]?.runTimeProvenance;
    if (!p) continue;
    sanity.runTimeShas[system] = p.repoShas;
    if (p.mixed) sanity.flags.push(`${system}: MIXED run-time SHAs ${p.repoShas.join(" + ")} - results are spliced across commits, do not report`);
    if (p.repoShas.includes("unstamped")) sanity.flags.push(`${system}: rows without a run-time SHA stamp`);
  }
  const allShas = [...new Set(Object.values(sanity.runTimeShas).flat() as string[])];
  sanity.singleShaAcrossSystems = allShas.length === 1;
  if (allShas.length > 1) sanity.flags.push(`systems were run at different SHAs: ${allShas.join(" + ")}`);

  // Any system named hybrid must have proven its vector leg ran.
  for (const system of systems) {
    if (!/hybrid/.test(system)) continue;
    const v = report.systems[system]?.vectorLiveness;
    if (!v) { sanity.flags.push(`${system}: no vector liveness evidence recorded`); continue; }
    if (v.questionsWithZeroVectorCredit > 0) {
      sanity.flags.push(`${system}: ${v.questionsWithZeroVectorCredit} question(s) with ZERO vector-credited hits - possible silent degrade to BM25`);
    }
    if (v.fullyEmbeddedQuestions < v.rowsWithDiag) {
      sanity.flags.push(`${system}: only ${v.fullyEmbeddedQuestions}/${v.rowsWithDiag} questions had every document embedded`);
    }
  }

  sanity.atOrBelowRandom = [] as string[];
  for (const system of systems) {
    const m = overallBySystem[system];
    if (!m) continue;
    if (m.recallAt[10]! > 0.95) sanity.flags.push(`${system} recall@10=${m.recallAt[10]!.toFixed(4)} - implausibly high, treat as a bug until explained`);
    // Any system not convincingly above chance must be named as such.
    const floor = report.systems[system]?.analyticRandomBaseline?.recallAt?.[10];
    if (system !== "random" && typeof floor === "number") {
      const tol = 3 * Math.sqrt(Math.max(floor * (1 - floor), 1e-6) / Math.max(1, m.n));
      if (m.recallAt[10]! <= floor + tol) sanity.atOrBelowRandom.push(system);
    }
  }
  if (sanity.atOrBelowRandom.length) {
    sanity.flags.push(`at or below the random floor on recall@10: ${sanity.atOrBelowRandom.join(", ")}`);
  }
  if (raw["bm25"]?.length && raw["memory-core"]?.length) {
    sanity.top10JaccardBm25VsMemoryCore = jaccardTop10(raw["bm25"]!, raw["memory-core"]!);
  }
  report.sanity = sanity;

  lines.push("## Sanity checks");
  lines.push("");
  if (sanity.randomControlOk !== undefined) {
    lines.push(`- random control recall@10 = ${fmt(sanity.randomEmpiricalRecallAt10)} vs analytic floor ${fmt(sanity.randomAnalyticRecallAt10)} (3 sigma tol +/-${fmt(sanity.randomTolerance3Sigma)}) -> ${sanity.randomControlOk ? "OK" : "MISMATCH"}`);
  }
  if (sanity.top10JaccardBm25VsMemoryCore !== undefined) {
    lines.push(`- mean top-10 Jaccard(bm25, memory-core) = ${fmt(sanity.top10JaccardBm25VsMemoryCore)}`);
  }
  lines.push(`- run-time SHA per system (stamped by the worker, not the scorer): ${JSON.stringify(sanity.runTimeShas)}`);
  lines.push(`- single SHA across all systems: ${sanity.singleShaAcrossSystems ? "yes" : "NO"}`);
  for (const system of systems) {
    const v = report.systems[system]?.vectorLiveness;
    if (!v) continue;
    lines.push(`- ${system} vector liveness: ${(v.meanVectorCreditedFraction * 100).toFixed(1)}% of hits vector-credited, ${v.fullyEmbeddedQuestions}/${v.rowsWithDiag} questions fully embedded, ${v.questionsWithZeroVectorCredit} with zero credit; reasons e.g. ${JSON.stringify(v.sampleReasons)}`);
  }
  lines.push(sanity.flags.length ? `- FLAGS: ${sanity.flags.join("; ")}` : "- no flags");
  lines.push("");
  lines.push("## Honesty note");
  lines.push("");
  lines.push("These are OUR numbers from OUR harness on the public LongMemEval_S dataset (500 questions).");
  lines.push("They are NOT comparable to published LongMemEval leaderboard figures: different retrieval");
  lines.push("granularity (one memory per turn), different corpus construction, no reader model in Mode A,");
  lines.push("and a different protocol. Do not place these next to third-party numbers as a comparison.");

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const jsonPath = path.join(RESULTS_DIR, `modeA-${tag}.json`);
  const mdPath = path.join(RESULTS_DIR, `modeA-${tag}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
  console.log(`\nwrote ${jsonPath}\nwrote ${mdPath}`);
}

main();
