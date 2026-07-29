#!/usr/bin/env node
/**
 * Retrieval-quality harness for memory-core.
 *
 *   npx tsx bench/run.ts
 *   npx tsx bench/run.ts --systems=in-memory,file,enhanced,bm25,random,naive-rag \
 *                        --size=small --k=10 --json=bench/out/run.json
 *
 * Every system goes through the same ingest -> search path over the same corpus, and
 * `random` is always run as a control. See bench/README.md for what this does and does
 * not prove; this is a synthetic in-repo dataset, not LongMemEval.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  datasetHash, defaultTimeAnchor, loadOrCreateDataset, materialize,
} from "./dataset/generate.js";
import {
  analyticRandomBaseline, computeAbstentionMetrics, computeRankMetrics, latencyStats,
  type QueryOutcome, type RandomBaseline, type SystemReport,
} from "./metrics.js";
import { resolveEmbedder, type EmbedderKind } from "./embedder.js";
import { buildSystem, DEFAULT_SYSTEMS, KNOWN_SYSTEMS, type SystemName } from "./systems/index.js";
import { FAMILIES, SkipSystem, type Dataset, type MaterializedMemory, type SystemContext } from "./types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Uniform ranking depth for every system. src providers hard-cap search at 100 hits
 * (Math.min(limit, 100)), so asking anyone for more would make the comparison unequal.
 * Gold outside the top 100 counts as not retrieved and is charged corpusSize + 1 in meanRank.
 */
const RETRIEVAL_DEPTH = 100;

interface Args {
  systems: SystemName[];
  size: "small" | "large";
  k: number;
  seed: number;
  json?: string;
  embedder: EmbedderKind;
  timeAnchor: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
  };

  const rawSystems = get("systems");
  const systems = (rawSystems ? rawSystems.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SYSTEMS) as SystemName[];
  for (const s of systems) {
    if (!KNOWN_SYSTEMS.includes(s)) {
      throw new Error(`unknown system "${s}". known: ${KNOWN_SYSTEMS.join(", ")}`);
    }
  }

  const size = (get("size") ?? "small") as "small" | "large";
  if (size !== "small" && size !== "large") throw new Error(`--size must be small|large`);

  const embedder = (get("embedder") ?? "hash") as EmbedderKind;
  if (!["hash", "bench-hash", "minilm"].includes(embedder)) {
    throw new Error(`--embedder must be hash|bench-hash|minilm`);
  }

  return {
    systems,
    size,
    k: Number(get("k") ?? "10"),
    seed: Number(get("seed") ?? "1337"),
    json: get("json"),
    embedder,
    timeAnchor: get("time-anchor") ?? defaultTimeAnchor(),
  };
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

function gitDirty(): boolean {
  try {
    return execSync("git status --porcelain", { cwd: HERE, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
  } catch {
    return false;
  }
}

async function runSystem(
  name: SystemName,
  dataset: Dataset,
  memories: MaterializedMemory[],
  ctx: SystemContext,
  ks: number[],
): Promise<SystemReport> {
  const built = await buildSystem(name, ctx);
  const system = built.system;
  const corpusSize = memories.length;

  const emptyReport = (status: "error" | "skipped", error: string): SystemReport => ({
    system: name,
    note: system.note,
    status,
    error,
    networkBound: system.networkBound ?? false,
    corpusSize,
    overall: computeRankMetrics("overall", [], new Map(), corpusSize, ks),
    perFamily: {},
    abstention: computeAbstentionMetrics([], new Map(), system.defaultMinScore),
    ingest: { records: 0, totalMs: 0, recordsPerSec: 0 },
    search: latencyStats([]),
    atOrBelowRandom: false,
    failedQueries: 0,
  });

  try {
    if (system.setup) await system.setup();
  } catch (error) {
    if (error instanceof SkipSystem) return emptyReport("skipped", error.message);
    return emptyReport("error", `setup failed: ${(error as Error).message}`);
  }

  let ingestMs = 0;
  try {
    const t0 = performance.now();
    await system.ingest(memories);
    ingestMs = performance.now() - t0;
  } catch (error) {
    await system.teardown?.().catch(() => {});
    return emptyReport("error", `ingest failed: ${(error as Error).message}`);
  }

  const outcomes = new Map<string, QueryOutcome>();
  const latencies: number[] = [];
  let failedQueries = 0;

  for (const item of dataset.items) {
    const t0 = performance.now();
    try {
      const ranking = await system.search(item.query, RETRIEVAL_DEPTH);
      const latencyMs = performance.now() - t0;
      latencies.push(latencyMs);
      outcomes.set(item.id, { itemId: item.id, family: item.family, ranking, latencyMs });
    } catch (error) {
      // A throwing query is recorded as a miss; it must not kill the run.
      failedQueries++;
      outcomes.set(item.id, {
        itemId: item.id, family: item.family, ranking: [],
        latencyMs: performance.now() - t0, error: (error as Error).message,
      });
    }
  }

  await system.teardown?.().catch(() => {});

  const overall = computeRankMetrics("overall", dataset.items, outcomes, corpusSize, ks);
  const perFamily: Record<string, ReturnType<typeof computeRankMetrics>> = {};
  for (const family of FAMILIES) {
    if (family === "abstention") continue;
    const items = dataset.items.filter((i) => i.family === family);
    if (items.length > 0) perFamily[family] = computeRankMetrics(family, items, outcomes, corpusSize, ks);
  }

  const baseline = analyticRandomBaseline(dataset.items, corpusSize, ks, RETRIEVAL_DEPTH);
  // `random` is the control itself, so scoring at chance is its job, not a finding.
  const atOrBelowRandom = name !== "random" && overall.recallAt[10]! <= (baseline.recallAt[10] ?? 0) * 1.5;

  return {
    system: name,
    note: system.note,
    status: failedQueries === dataset.items.length && dataset.items.length > 0 ? "error" : "ok",
    error: failedQueries > 0 ? `${failedQueries} queries threw` : undefined,
    networkBound: system.networkBound ?? false,
    corpusSize,
    overall,
    perFamily,
    abstention: computeAbstentionMetrics(dataset.items, outcomes, system.defaultMinScore),
    ingest: {
      records: memories.length,
      totalMs: ingestMs,
      recordsPerSec: ingestMs > 0 ? (memories.length / ingestMs) * 1000 : 0,
    },
    search: latencyStats(latencies),
    atOrBelowRandom,
    failedQueries,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const pct = (v: number | null | undefined) => (v == null || Number.isNaN(v) ? "  -  " : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null | undefined, d = 3) => (v == null || Number.isNaN(v) ? "  -  " : v.toFixed(d));

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function printReport(reports: SystemReport[], baseline: RandomBaseline, dataset: Dataset): void {
  const ok = reports.filter((r) => r.status === "ok");

  console.log("\n=== RETRIEVAL QUALITY ===");
  console.log(
    table(
      ["system", "R@1", "R@5", "R@10", "allGold@10", "MRR", "nDCG@10", "meanRank", "found"],
      [
        ...ok.map((r) => [
          r.system, pct(r.overall.recallAt[1]), pct(r.overall.recallAt[5]), pct(r.overall.recallAt[10]),
          pct(r.overall.allGoldAt[10]), num(r.overall.mrr), num(r.overall.ndcgAt10),
          num(r.overall.meanRank, 1), pct(r.overall.foundRate),
        ]),
        [
          "[analytic random]", pct(baseline.recallAt[1]), pct(baseline.recallAt[5]), pct(baseline.recallAt[10]),
          pct(baseline.allGoldAt[10]), num(baseline.mrr), "  -  ", num(baseline.meanRank, 1), "  -  ",
        ],
      ],
    ),
  );
  console.log(
    `\ncorpus=${baseline.corpusSize} memories, depth=${RETRIEVAL_DEPTH}, unretrieved gold charged rank ${baseline.corpusSize + 1}`,
  );

  const flagged = ok.filter((r) => r.atOrBelowRandom);
  if (flagged.length > 0) {
    console.log("");
    for (const r of flagged) {
      console.log(
        `!! AT/BELOW RANDOM: ${r.system} recall@10=${pct(r.overall.recallAt[10])} vs analytic random ${pct(baseline.recallAt[10])} ` +
        `(meanRank ${num(r.overall.meanRank, 1)} vs ${num(baseline.meanRank, 1)}). Its ranking carries little or no signal.`,
      );
    }
  }

  console.log("\n=== PER-FAMILY recall@10 (allGold@10 in brackets) ===");
  const families = FAMILIES.filter((f) => f !== "abstention");
  console.log(
    table(
      ["system", ...families],
      ok.map((r) => [
        r.system,
        ...families.map((f) => {
          const m = r.perFamily[f];
          return m ? `${pct(m.recallAt[10])} [${pct(m.allGoldAt[10])}]` : "  -  ";
        }),
      ]),
    ),
  );

  console.log("\n=== PER-FAMILY MRR (recall@10 saturates; MRR shows where gold actually lands) ===");
  console.log(
    table(
      ["system", ...families],
      [
        ...ok.map((r) => [r.system, ...families.map((f) => num(r.perFamily[f]?.mrr))]),
        ["[analytic random]", ...families.map(() => num(baseline.mrr))],
      ],
    ),
  );

  console.log("\n=== KNOWLEDGE-UPDATE staleness (lower is better) ===");
  console.log(
    table(
      ["system", "staleRate", "recall@10 (current)", "meanRank"],
      ok.map((r) => {
        const m = r.perFamily["knowledge-update"];
        return [r.system, pct(m?.staleRate), pct(m?.recallAt[10]), num(m?.meanRank, 1)];
      }),
    ),
  );
  console.log("staleRate = a superseded memory outranked the current one. Both records are ingested `active`;");
  console.log("nothing is pre-marked superseded, so detecting the update is the system's job.");

  console.log("\n=== ABSTENTION (paired: FPR must be read next to the recall beside it) ===");
  console.log(
    table(
      ["system", "n(no-answer)", "tau@90%keep", "FPR@tau", "keep@tau", "own gate", "FPR@gate", "R@10 @gate"],
      ok.map((r) => {
        // A system with no gate would show a trivial 100% FPR; say "none" instead of
        // reporting a number that looks measured.
        const hasGate = r.abstention.systemGate > 0;
        return [
          r.system, String(r.abstention.nUnanswerable), num(r.abstention.operatingThreshold),
          pct(r.abstention.fprAtOperatingPoint), pct(r.abstention.retentionAtOperatingPoint),
          hasGate ? num(r.abstention.systemGate, 2) : "none",
          hasGate ? pct(r.abstention.fprAtSystemGate) : "n/a",
          hasGate ? pct(r.abstention.recallAt10AtSystemGate) : "n/a",
        ];
      }),
    ),
  );
  console.log("tau@90%keep: per-system score that retains 90% of answerable queries in THIS run (score scales differ,");
  console.log("so a shared absolute threshold would be meaningless). FPR@tau = no-answer queries still confident at tau.");
  console.log("FPR@gate is paired with R@10 @gate: suppressing everything drives FPR to 0 and recall to 0 together.");

  console.log("\n=== LATENCY / THROUGHPUT (reported separately from retrieval quality) ===");
  console.log(
    table(
      ["system", "ingest ms", "rec/s", "search mean ms", "p95 ms", "q/s", "net-bound"],
      ok.map((r) => [
        r.system, num(r.ingest.totalMs, 1), num(r.ingest.recordsPerSec, 1),
        num(r.search.meanMs, 3), num(r.search.p95Ms, 3), num(r.search.throughputPerSec, 1),
        r.networkBound ? "YES" : "no",
      ]),
    ),
  );
  if (ok.some((r) => r.networkBound)) {
    console.log("net-bound systems: wall-clock is dominated by network RTT, not retrieval work. Do not compare");
    console.log("their latency against in-process systems, and do not let it colour their quality numbers.");
  }

  const notOk = reports.filter((r) => r.status !== "ok");
  if (notOk.length > 0) {
    console.log("\n=== SKIPPED / FAILED ===");
    for (const r of notOk) console.log(`  ${r.system}: ${r.status} - ${r.error}`);
  }

  console.log("\n=== PROVENANCE ===");
  console.log(`dataset: ${dataset.meta.name} v${dataset.meta.version} (SYNTHETIC, authored in this repo)`);
  console.log(`items=${dataset.meta.counts.items} memories=${dataset.meta.counts.memories} sessions=${dataset.meta.counts.sessions}`);
  console.log("This is NOT LongMemEval, LoCoMo, or any published benchmark. Numbers here are not comparable");
  console.log("to published scores on those suites. See bench/README.md.");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ks = [...new Set([1, 5, args.k])].sort((a, b) => a - b);

  const { dataset, file } = loadOrCreateDataset(args.size, args.seed);
  const hash = datasetHash(dataset);
  const memories = materialize(dataset, args.timeAnchor);

  // `random` is the control that catches an uninformative ranker. Always run it.
  const systems: SystemName[] = args.systems.includes("random")
    ? args.systems
    : [...args.systems, "random"];

  const runId = `${args.size}-${args.seed}-${hash}`;
  const workDir = path.join(HERE, "out", runId);
  mkdirSync(workDir, { recursive: true });

  const ctx: SystemContext = {
    seed: args.seed,
    allMemoryIds: memories.map((m) => m.id),
    embedderName: args.embedder,
    workDir,
    runId,
  };

  console.log(`memory-core internal retrieval suite`);
  console.log(`dataset=${path.relative(process.cwd(), file)} hash=${hash} seed=${args.seed} size=${args.size}`);
  console.log(`systems=${systems.join(",")} depth=${RETRIEVAL_DEPTH} k=${args.k} embedder=${args.embedder}`);
  const resolvedEmbedder = await resolveEmbedder(args.embedder);
  console.log(`timeAnchor=${args.timeAnchor}`);
  console.log(
    `embedder: requested=${args.embedder} resolved=${resolvedEmbedder.provider.name} ` +
    `fromSrc=${resolvedEmbedder.fromSrc}${resolvedEmbedder.fromSrc ? "" : " (src/retrieval/embedder.ts not used)"}`,
  );

  const reports: SystemReport[] = [];
  for (const name of systems) {
    process.stdout.write(`  running ${name} ... `);
    try {
      const report = await runSystem(name, dataset, memories, ctx, ks);
      reports.push(report);
      console.log(report.status === "ok" ? "ok" : `${report.status} (${report.error})`);
    } catch (error) {
      // Last-resort guard: one broken system never kills the run.
      console.log(`error (${(error as Error).message})`);
      reports.push({
        system: name, status: "error", error: (error as Error).message, networkBound: false,
        corpusSize: memories.length,
        overall: computeRankMetrics("overall", [], new Map(), memories.length, ks),
        perFamily: {}, abstention: computeAbstentionMetrics([], new Map(), 0),
        ingest: { records: 0, totalMs: 0, recordsPerSec: 0 }, search: latencyStats([]),
        atOrBelowRandom: false, failedQueries: 0,
      });
    }
  }

  const baseline = analyticRandomBaseline(dataset.items, memories.length, ks, RETRIEVAL_DEPTH);
  printReport(reports, baseline, dataset);

  const payload = {
    harness: "bench/run.ts",
    command: `node ${process.argv.slice(1).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
    argv: process.argv.slice(2),
    ranAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    gitSha: gitSha(),
    gitDirty: gitDirty(),
    dataset: {
      name: dataset.meta.name,
      version: dataset.meta.version,
      file: path.relative(process.cwd(), file),
      hash,
      seed: args.seed,
      size: args.size,
      counts: dataset.meta.counts,
      synthetic: true,
      notLongMemEval: "Synthetic dataset authored in this repo. Not comparable to LongMemEval or any published suite.",
    },
    config: {
      retrievalDepth: RETRIEVAL_DEPTH, ks, timeAnchor: args.timeAnchor,
      embedderRequested: args.embedder,
      embedderResolved: resolvedEmbedder.provider.name,
      embedderFromSrc: resolvedEmbedder.fromSrc,
    },
    randomBaselineAnalytic: baseline,
    systems: reports,
  };

  const jsonPath = args.json ? path.resolve(args.json) : path.join(workDir, "results.json");
  mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`\nJSON: ${path.relative(process.cwd(), jsonPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
