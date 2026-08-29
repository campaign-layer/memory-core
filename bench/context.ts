#!/usr/bin/env node
/**
 * Context-assembly regression harness.
 *
 * This intentionally reuses the repository-authored synthetic corpus, so the
 * output is an internal regression signal rather than a public benchmark claim.
 * It measures the exact buildContext surface agents consume, not search alone.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { InMemoryProvider } from "../src/providers/in-memory-provider.js";
import { createReranker, type RerankerKind } from "../src/retrieval/rerank.js";
import { MemoryCoreService } from "../src/service.js";
import { tokenize } from "../src/utils.js";
import {
  datasetHash,
  defaultTimeAnchor,
  loadOrCreateDataset,
  materialize,
} from "./dataset/generate.js";
import {
  BENCH_ACTOR,
  BENCH_APP,
  BENCH_TENANT,
  FAMILIES,
  toMemoryRecord,
  type EvalItem,
  type Family,
} from "./types.js";

interface Args {
  size: "small" | "large";
  seed: number;
  maxItems: number;
  maxChars: number;
  timeAnchor: string;
  reranker: RerankerKind;
  rerankerModel?: string;
  rerankerMinScore: number;
  assertBaseline: boolean;
  json?: string;
}

interface ItemOutcome {
  item: EvalItem;
  selectedIds: Set<string>;
  selectedCount: number;
  goldFound: number;
  allGold: boolean;
  staleSelected: number;
  staleOutranksCurrent: boolean;
  hardNegativeSelected: number;
  hardNegativeOutranksGold: boolean;
  bestGoldRank: number | null;
  contextChars: number;
  pairSimilarities: number[];
  latencyMs: number;
}

function value(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function parseArgs(argv: string[]): Args {
  const size = (value(argv, "size") ?? "small") as Args["size"];
  if (size !== "small" && size !== "large") throw new Error("--size must be small|large");

  const seed = Number(value(argv, "seed") ?? "1337");
  const maxItems = Number(value(argv, "max-items") ?? "8");
  const maxChars = Number(value(argv, "max-chars") ?? "3000");
  const reranker = (value(argv, "reranker") ?? process.env.MEMORY_RERANKER ?? "none") as RerankerKind;
  const rerankerMinScore = Number(
    value(argv, "reranker-min-score") ?? process.env.MEMORY_RERANKER_MIN_SCORE ?? "0",
  );
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 30) {
    throw new Error("--max-items must be an integer in 1..30");
  }
  if (!Number.isInteger(maxChars) || maxChars < 300 || maxChars > 20000) {
    throw new Error("--max-chars must be an integer in 300..20000");
  }
  if (reranker !== "none" && reranker !== "voyage") {
    throw new Error("--reranker must be none|voyage");
  }
  if (!Number.isFinite(rerankerMinScore) || rerankerMinScore < 0 || rerankerMinScore > 1) {
    throw new Error("--reranker-min-score must be a number in 0..1");
  }
  if (reranker === "voyage" && !process.env.VOYAGE_API_KEY) {
    throw new Error("--reranker=voyage requires VOYAGE_API_KEY; refusing to silently benchmark fallback ranking");
  }

  return {
    size,
    seed,
    maxItems,
    maxChars,
    reranker,
    rerankerModel: value(argv, "reranker-model") ?? process.env.MEMORY_RERANKER_MODEL,
    rerankerMinScore,
    assertBaseline: argv.includes("--assert-baseline"),
    timeAnchor: value(argv, "time-anchor") ?? defaultTimeAnchor(),
    json: value(argv, "json"),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, number) => sum + number, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function jaccard(left: string, right: string): number {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function pairSimilarities(texts: string[]): number[] {
  const similarities: number[] = [];
  for (let left = 0; left < texts.length; left += 1) {
    for (let right = left + 1; right < texts.length; right += 1) {
      similarities.push(jaccard(texts[left] ?? "", texts[right] ?? ""));
    }
  }
  return similarities;
}

function round(number: number): number {
  return Math.round(number * 10_000) / 10_000;
}

function summarize(outcomes: ItemOutcome[], maxChars: number) {
  const answerable = outcomes.filter((outcome) => outcome.item.goldMemoryIds.length > 0);
  const totalGold = answerable.reduce((sum, outcome) => sum + outcome.item.goldMemoryIds.length, 0);
  const updateItems = outcomes.filter((outcome) => outcome.item.family === "knowledge-update");
  const hardNegativeItems = outcomes.filter((outcome) => (outcome.item.hardNegativeIds?.length ?? 0) > 0);
  const similarities = outcomes.flatMap((outcome) => outcome.pairSimilarities);
  const latencies = outcomes.map((outcome) => outcome.latencyMs);
  const reciprocalRanks = answerable.map((outcome) =>
    outcome.bestGoldRank === null ? 0 : 1 / outcome.bestGoldRank,
  );
  const abstentionItems = outcomes.filter((outcome) => outcome.item.family === "abstention");

  return {
    queries: outcomes.length,
    answerableQueries: answerable.length,
    evidenceRecall: round(answerable.reduce((sum, outcome) => sum + outcome.goldFound, 0) / Math.max(totalGold, 1)),
    allGoldRate: round(answerable.filter((outcome) => outcome.allGold).length / Math.max(answerable.length, 1)),
    goldAtOneRate: round(
      answerable.filter((outcome) => outcome.bestGoldRank === 1).length / Math.max(answerable.length, 1),
    ),
    meanReciprocalRank: round(mean(reciprocalRanks)),
    staleSelectionRate: round(updateItems.filter((outcome) => outcome.staleSelected > 0).length / Math.max(updateItems.length, 1)),
    staleOutranksCurrentRate: round(
      updateItems.filter((outcome) => outcome.staleOutranksCurrent).length / Math.max(updateItems.length, 1),
    ),
    hardNegativeSelectionRate: round(
      hardNegativeItems.filter((outcome) => outcome.hardNegativeSelected > 0).length /
        Math.max(hardNegativeItems.length, 1),
    ),
    hardNegativeOutranksGoldRate: round(
      hardNegativeItems.filter((outcome) => outcome.hardNegativeOutranksGold).length /
        Math.max(hardNegativeItems.length, 1),
    ),
    meanHardNegativesSelected: round(mean(hardNegativeItems.map((outcome) => outcome.hardNegativeSelected))),
    abstentionLeakRate: round(
      abstentionItems.filter((outcome) => outcome.selectedCount > 0).length / Math.max(abstentionItems.length, 1),
    ),
    meanSelected: round(mean(outcomes.map((outcome) => outcome.selectedCount))),
    meanPairwiseJaccard: round(mean(similarities)),
    nearDuplicatePairRate: round(
      similarities.filter((similarity) => similarity >= 0.8).length / Math.max(similarities.length, 1),
    ),
    budgetViolations: outcomes.filter((outcome) => outcome.contextChars > maxChars).length,
    meanChars: round(mean(outcomes.map((outcome) => outcome.contextChars))),
    maxCharsObserved: Math.max(...outcomes.map((outcome) => outcome.contextChars), 0),
    meanBudgetUtilization: round(mean(outcomes.map((outcome) => outcome.contextChars / maxChars))),
    latencyMs: {
      mean: round(mean(latencies)),
      p95: round(percentile(latencies, 0.95)),
      max: round(Math.max(...latencies, 0)),
    },
  };
}

function assertRegressionBaseline(overall: ReturnType<typeof summarize>): void {
  const failures: string[] = [];
  const floor = (name: keyof typeof overall, value: number) => {
    const actual = overall[name];
    if (typeof actual !== "number" || actual < value) failures.push(`${String(name)}=${String(actual)} < ${value}`);
  };
  const ceiling = (name: keyof typeof overall, value: number) => {
    const actual = overall[name];
    if (typeof actual !== "number" || actual > value) failures.push(`${String(name)}=${String(actual)} > ${value}`);
  };

  // Deliberately loose release floors around the deterministic 2026-08-29
  // baseline. They catch an accidental retrieval/context regression without
  // pretending this repository-authored fixture is a production-quality bar.
  floor("evidenceRecall", 0.75);
  floor("allGoldRate", 0.70);
  floor("goldAtOneRate", 0.45);
  floor("meanReciprocalRank", 0.58);
  ceiling("staleOutranksCurrentRate", 0.40);
  ceiling("hardNegativeOutranksGoldRate", 0.40);
  ceiling("nearDuplicatePairRate", 0.01);
  if (overall.budgetViolations !== 0) failures.push(`budgetViolations=${overall.budgetViolations} != 0`);

  if (failures.length > 0) {
    throw new Error(`context regression baseline failed: ${failures.join(", ")}`);
  }
}

function gitState(): { sha: string; dirty: boolean } {
  try {
    return {
      sha: execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(),
      dirty: execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0,
    };
  } catch {
    return { sha: "unknown", dirty: false };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { dataset, file } = loadOrCreateDataset(args.size, args.seed);
  const memories = materialize(dataset, args.timeAnchor);
  const provider = new InMemoryProvider();
  await provider.ingest(memories.map(toMemoryRecord));
  const reranker = createReranker({ kind: args.reranker, model: args.rerankerModel });
  const service = new MemoryCoreService(provider, {
    reranker,
    rerankerMinScore: args.rerankerMinScore,
  });
  const filters = {
    tenantId: BENCH_TENANT,
    spaceId: BENCH_ACTOR,
    appId: BENCH_APP,
    actorId: BENCH_ACTOR,
  };

  const outcomes: ItemOutcome[] = [];
  for (const item of dataset.items) {
    const startedAt = performance.now();
    const context = await service.buildContext({
      query: item.query,
      filters,
      budget: { maxItems: args.maxItems, maxChars: args.maxChars },
    });
    const latencyMs = performance.now() - startedAt;
    // Measure every record that the agent actually receives. Relevant evidence
    // is rendered first, then non-duplicated profile background.
    const emittedMemories = [...context.selectedMemories, ...(context.profileMemories ?? [])];
    const selectedIds = new Set(emittedMemories.map((memory) => memory.id));
    const selectedRanks = new Map(emittedMemories.map((memory, index) => [memory.id, index + 1]));
    const ranksOf = (ids: string[] | undefined): number[] =>
      (ids ?? []).map((id) => selectedRanks.get(id)).filter((rank): rank is number => rank !== undefined);
    const goldRanks = ranksOf(item.goldMemoryIds);
    const staleRanks = ranksOf(item.supersededMemoryIds);
    const hardNegativeRanks = ranksOf(item.hardNegativeIds);
    const bestGoldRank = goldRanks.length > 0 ? Math.min(...goldRanks) : null;
    outcomes.push({
      item,
      selectedIds,
      selectedCount: emittedMemories.length,
      goldFound: item.goldMemoryIds.filter((id) => selectedIds.has(id)).length,
      allGold: item.goldMemoryIds.length > 0 && item.goldMemoryIds.every((id) => selectedIds.has(id)),
      staleSelected: (item.supersededMemoryIds ?? []).filter((id) => selectedIds.has(id)).length,
      staleOutranksCurrent:
        bestGoldRank !== null && staleRanks.length > 0 && Math.min(...staleRanks) < bestGoldRank,
      hardNegativeSelected: (item.hardNegativeIds ?? []).filter((id) => selectedIds.has(id)).length,
      hardNegativeOutranksGold:
        bestGoldRank !== null && hardNegativeRanks.length > 0 && Math.min(...hardNegativeRanks) < bestGoldRank,
      bestGoldRank,
      contextChars: context.contextText.length,
      pairSimilarities: pairSimilarities(emittedMemories.map((memory) => memory.text)),
      latencyMs,
    });
  }

  const overall = summarize(outcomes, args.maxChars);
  const rerankerStatus = service.getRerankerStatus();
  if (rerankerStatus.configured && (rerankerStatus.failures > 0 || rerankerStatus.fallbacks > 0)) {
    throw new Error(
      `configured reranker degraded during benchmark: ${JSON.stringify(rerankerStatus)}`,
    );
  }
  if (overall.budgetViolations > 0) {
    throw new Error(`context benchmark exceeded the configured character budget ${overall.budgetViolations} time(s)`);
  }
  if (args.assertBaseline) assertRegressionBaseline(overall);
  const perFamily = Object.fromEntries(
    FAMILIES.map((family: Family) => [
      family,
      summarize(outcomes.filter((outcome) => outcome.item.family === family), args.maxChars),
    ]),
  );
  const report = {
    suite: "memory-core-internal-context-assembly",
    warning: "Repository-authored synthetic corpus; internal regression signal only.",
    dataset: {
      name: dataset.meta.name,
      version: dataset.meta.version,
      size: args.size,
      seed: args.seed,
      hash: datasetHash(dataset),
      file,
      timeAnchor: args.timeAnchor,
    },
    git: gitState(),
    budget: { maxItems: args.maxItems, maxChars: args.maxChars },
    retrieval: {
      provider: "in-memory",
      embedder: "none",
      reranker: reranker?.id ?? "none",
      rerankerMinScore: args.rerankerMinScore,
      rerankerStatus,
    },
    overall,
    perFamily,
  };

  console.log("memory-core context assembly (internal synthetic regression only)");
  console.log(`dataset=${dataset.meta.name} v${dataset.meta.version} hash=${report.dataset.hash} size=${args.size} seed=${args.seed}`);
  console.log(`budget=maxItems:${args.maxItems} maxChars:${args.maxChars} anchor=${args.timeAnchor}`);
  console.log(`retrieval=BM25 reranker=${reranker?.id ?? "none"} rerankerMinScore=${args.rerankerMinScore}`);
  console.log(JSON.stringify(overall, null, 2));

  if (args.json) {
    const target = path.resolve(args.json);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`wrote ${target}`);
  }
}

await main();
