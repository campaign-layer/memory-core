/**
 * Mode A scorer. One grader for every system, so the metric definition, the gold
 * labels, the denominator and the retrieval depth cannot differ between rows.
 *
 * Reuses memory-core's bench/metrics.ts (recall@k with partial credit, MRR, nDCG@10,
 * mean/median rank, analytic random baseline) rather than reimplementing it.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import {
  analyticRandomBaseline, computeRankMetrics, type QueryOutcome,
} from "../metrics.js";
import type { EvalItem, Family, RankedHit } from "../types.js";
import { CORPUS, OUT, RANKINGS, REPO_ROOT, requireCorpus, requireDir } from "./paths.js";

const KS = [1, 5, 10, 30] as const;
const DEPTH = 30;

interface Question {
  qid: string; sample_id: string; category: string; category_label: string;
  question: string; gold_turn_ids: string[]; answerable: boolean; adversarial: boolean;
}
interface Corpus {
  meta: Record<string, any>;
  conversations: Array<{ sample_id: string; turns: Array<{ id: string }>; questions: Question[] }>;
}
interface RankRow {
  system: string; sample_id: string; qid: string; latency_ms?: number;
  items: Array<{ turn_ids: string[]; score: number | null; mem_id?: string }>;
}

/**
 * Turns the shared item format into a positional ranking of turn ids.
 *
 * An item that attributes to no turn (mem0 retrieving a consolidated memory whose
 * provenance is empty) still CONSUMED a retrieval slot, so it is replaced by a
 * placeholder id rather than skipped. Dropping it would silently hand mem0 a
 * shorter, denser list than every other system got.
 */
function toRanking(row: RankRow): RankedHit[] {
  const out: RankedHit[] = [];
  const seen = new Set<string>();
  let i = 0;
  for (const item of row.items) {
    const score = typeof item.score === "number" ? item.score : 0;
    if (!item.turn_ids || item.turn_ids.length === 0) {
      out.push({ id: `__unattributed_${i++}__`, score });
      continue;
    }
    for (const tid of item.turn_ids) {
      if (seen.has(tid)) continue;
      seen.add(tid);
      out.push({ id: tid, score });
    }
  }
  return out;
}

function loadRows(file: string): Map<string, RankRow> {
  const m = new Map<string, RankRow>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as RankRow;
    m.set(r.qid, r);
  }
  return m;
}

function fmt(x: number | null | undefined, d = 3): string {
  return x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(d);
}

const USAGE = [
  "LoCoMo Mode A scorer. One grader for every system on disk.",
  "",
  "  npx tsx score_mode_a.ts [--corpus=FILE] [--rankings=DIR] [--out=FILE]",
  "",
  "Scores every *.jsonl in the ranking directory against the same gold labels,",
  "the same denominator and the same retrieval depth.",
].join("\n");

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const get = (k: string, d?: string) => {
    const hit = args.find((a) => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const corpusPath = get("corpus", CORPUS)!;
  const rankDir = get("rankings", RANKINGS)!;
  const outPath = get("out", path.join(OUT, "mode_a.json"))!;

  requireCorpus(corpusPath);
  requireDir(rankDir, "ranking directory",
    "Run run_retrieval.ts (and optionally run_retrieval2.ts / attribute_mem0.py) first.");
  const corpus: Corpus = JSON.parse(readFileSync(corpusPath, "utf8"));

  // Gold labels, built once and shared by every system.
  const questions: Question[] = corpus.conversations.flatMap((c) => c.questions);
  const answerable = questions.filter((q) => q.answerable && q.gold_turn_ids.length > 0);

  // Integrity guard: no gold answer text may appear in a ranking id, and no ranking
  // may reference a turn outside its own conversation's corpus.
  const turnsByConv = new Map(corpus.conversations.map((c) => [c.sample_id, new Set(c.turns.map((t) => t.id))]));

  const items: EvalItem[] = answerable.map((q) => ({
    id: q.qid,
    family: q.category as unknown as Family,
    query: q.question,
    goldMemoryIds: q.gold_turn_ids,
  }));

  // Corpora differ per conversation (369..689 turns). meanRank's miss penalty and the
  // analytic random baseline need one corpus size, so the MEAN is used, identically
  // for every system. medianRank and foundRate are penalty-free and reported alongside.
  const corpusSize = Math.round(corpus.meta.mean_corpus_size);

  const files = readdirSync(rankDir).filter((f) => f.endsWith(".jsonl"));
  const systems: any[] = [];

  for (const file of files.sort()) {
    const rows = loadRows(path.join(rankDir, file));
    const metaFile = path.join(rankDir, file.replace(/\.jsonl$/, ".meta.json"));
    const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
    const name: string = meta.system ?? [...rows.values()][0]?.system ?? file.replace(/\.jsonl$/, "");

    // Cross-conversation leakage guard.
    let foreign = 0;
    for (const r of rows.values()) {
      const allowed = turnsByConv.get(r.sample_id);
      for (const it of r.items) for (const t of it.turn_ids ?? []) if (allowed && !allowed.has(t)) foreign++;
    }

    const outcomes = new Map<string, QueryOutcome>();
    const latencies: number[] = [];
    let missing = 0;
    for (const q of answerable) {
      const r = rows.get(q.qid);
      if (!r) { missing++; continue; }
      if (typeof r.latency_ms === "number") latencies.push(r.latency_ms);
      outcomes.set(q.qid, {
        itemId: q.qid,
        family: q.category as unknown as Family,
        ranking: toRanking(r),
        latencyMs: r.latency_ms ?? 0,
      });
    }

    const overall = computeRankMetrics("overall", items, outcomes, corpusSize, KS);
    const perCategory: Record<string, any> = {};
    const cats = [...new Set(answerable.map((q) => q.category))].sort();
    for (const cat of cats) {
      const catItems = items.filter((_, i) => answerable[i]!.category === cat);
      perCategory[cat] = computeRankMetrics(cat, catItems, outcomes, corpusSize, KS);
    }

    systems.push({
      system: name,
      note: meta.note ?? null,
      queries_scored: outcomes.size,
      queries_missing: missing,
      foreign_turn_references: foreign,
      overall, perCategory,
      mean_latency_ms: latencies.length ? +(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(3) : null,
      ingest: {
        seconds: meta.ingest_seconds ?? (meta.ingest_ms != null ? +(meta.ingest_ms / 1000).toFixed(2) : null),
        llm_calls: meta.llm_calls ?? 0,
        prompt_tokens: meta.prompt_tokens ?? 0,
        completion_tokens: meta.completion_tokens ?? 0,
        usd_cost: meta.usd_cost ?? 0,
      },
      mean_attributed_turns_per_retrieved_item: meta.mean_attributed_turns_per_retrieved_item ?? 1,
    });
  }

  const random = analyticRandomBaseline(items, corpusSize, KS, DEPTH);

  let sha = "unknown";
  try {
    sha = execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch { /* not a repo */ }

  const report = {
    mode: "A (retrieval only)",
    provenance: {
      memory_core_git_sha: sha,
      dataset_path: corpus.meta.dataset_path,
      dataset_sha256: corpus.meta.dataset_sha256,
      corpus_sha256: corpus.meta.corpus_sha256,
      query_sha256: corpus.meta.query_sha256,
      command: `tsx score_mode_a.ts --corpus=${corpusPath} --rankings=${rankDir} --out=${outPath}`,
      node: process.version,
      generated_at: new Date().toISOString(),
    },
    setup: {
      conversations: corpus.meta.n_conversations,
      turns: corpus.meta.n_turns,
      questions_total: corpus.meta.n_questions,
      questions_scored_mode_a: answerable.length,
      excluded_from_mode_a: {
        adversarial_category_5: questions.filter((q) => q.adversarial).length,
        no_resolvable_evidence: questions.filter((q) => !q.adversarial && q.gold_turn_ids.length === 0).length,
        reason: "category 5 carries no retrieval gold: its listed evidence turn is the NEAR MISS that makes the "
              + "question adversarial, so retrieving it is not a success. Scored as abstention in Mode B instead.",
      },
      retrieval_depth: DEPTH,
      ks: KS,
      corpus_size_used_for_penalty_and_random: corpusSize,
      per_conversation_corpus_sizes: corpus.meta.corpus_sizes,
      category_labels: corpus.meta.category_labels,
    },
    analytic_random_baseline: random,
    systems,
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // ---- console tables --------------------------------------------------------
  const cats = Object.keys(systems[0]?.perCategory ?? {}).sort();
  const labels: Record<string, string> = corpus.meta.category_labels ?? {};

  console.log(`\n=== MODE A: overall (n=${answerable.length} answerable questions, depth=${DEPTH}) ===`);
  console.log("system                          R@1    R@5    R@10   R@30   MRR    nDCG10 meanRk medRk  found");
  for (const s of systems) {
    const o = s.overall;
    console.log(
      `${s.system.padEnd(30)} ${fmt(o.recallAt[1])}  ${fmt(o.recallAt[5])}  ${fmt(o.recallAt[10])}  ` +
      `${fmt(o.recallAt[30])}  ${fmt(o.mrr)}  ${fmt(o.ndcgAt10)}  ${fmt(o.meanRank, 1).padStart(6)} ` +
      `${fmt(o.medianRank, 1).padStart(6)} ${fmt(o.foundRate)}`);
  }
  console.log(`${"random (analytic)".padEnd(30)} ${fmt(random.recallAt[1])}  ${fmt(random.recallAt[5])}  ` +
    `${fmt(random.recallAt[10])}  ${fmt(random.recallAt[30])}  ${fmt(random.mrr)}  ` +
    `${"-".padStart(5)}  ${fmt(random.meanRank, 1).padStart(6)}`);

  for (const cat of cats) {
    const n = systems[0].perCategory[cat].n;
    console.log(`\n--- category ${cat} (${labels[cat] ?? "?"}), n=${n} ---`);
    console.log("system                          R@1    R@5    R@10   R@30   MRR    nDCG10 meanRk");
    for (const s of systems) {
      const o = s.perCategory[cat];
      console.log(
        `${s.system.padEnd(30)} ${fmt(o.recallAt[1])}  ${fmt(o.recallAt[5])}  ${fmt(o.recallAt[10])}  ` +
        `${fmt(o.recallAt[30])}  ${fmt(o.mrr)}  ${fmt(o.ndcgAt10)}  ${fmt(o.meanRank, 1).padStart(6)}`);
    }
  }

  console.log("\n=== ingest cost / wall-clock ===");
  console.log("system                          ingest_s   llm_calls  prompt_tok  compl_tok    usd     search_ms");
  for (const s of systems) {
    const g = s.ingest;
    console.log(`${s.system.padEnd(30)} ${String(g.seconds ?? "-").padStart(8)} ${String(g.llm_calls).padStart(10)} ` +
      `${String(g.prompt_tokens).padStart(11)} ${String(g.completion_tokens).padStart(10)} ` +
      `${g.usd_cost.toFixed(4).padStart(8)} ${fmt(s.mean_latency_ms, 2).padStart(10)}`);
  }

  const bad = systems.filter((s) => s.foreign_turn_references > 0 || s.queries_missing > 0);
  if (bad.length) {
    console.log("\n!! integrity warnings");
    for (const s of bad) {
      console.log(`   ${s.system}: missing=${s.queries_missing} foreign_turn_refs=${s.foreign_turn_references}`);
    }
  }
  console.log(`\nwrote ${outPath}`);
}

try {
  main();
} catch (err: any) {
  console.error(`\n${err?.message ?? err}\n`);
  process.exit(1);
}
