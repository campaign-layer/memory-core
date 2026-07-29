/**
 * Retrieval metrics.
 *
 * Design rule: no metric here can be maximised by returning everything.
 *  - abstention FPR is paired with recall measured at the SAME gate, so a system
 *    that suppresses everything scores 0 FPR and 0 recall.
 *  - meanRank and the random baseline are always reported, so a system ranking at
 *    chance cannot hide behind a non-zero recall@10.
 */
import type { Family, RankedHit } from "./types.js";
import { FAMILIES } from "./types.js";
import type { EvalItem } from "./types.js";

export const DEFAULT_KS = [1, 5, 10] as const;

export interface QueryOutcome {
  itemId: string;
  family: Family;
  ranking: RankedHit[];
  latencyMs: number;
  error?: string;
}

export interface RankMetrics {
  family: string;
  n: number;
  /** Fraction of gold memories inside top-k, averaged per item (partial credit). */
  recallAt: Record<number, number>;
  /** Fraction of items where EVERY gold memory is inside top-k. Multi-hop's honest number. */
  allGoldAt: Record<number, number>;
  mrr: number;
  ndcgAt10: number;
  /** Best gold rank, averaged. Unretrieved gold is charged corpusSize + 1. */
  meanRank: number;
  medianRank: number;
  /** Fraction of items where at least one gold memory appeared anywhere in the ranking. */
  foundRate: number;
  /** knowledge-update only: fraction where a superseded memory outranked the current one. */
  staleRate?: number;
}

export interface AbstentionMetrics {
  nUnanswerable: number;
  nAnswerable: number;
  /**
   * Scale-free operating point: the score that retains `targetRetention` of answerable
   * queries in THIS run. Necessary because score scales differ per system.
   */
  targetRetention: number;
  operatingThreshold: number | null;
  fprAtOperatingPoint: number | null;
  retentionAtOperatingPoint: number | null;
  /** The system's own documented default gate, and the utility that survives it. */
  systemGate: number;
  fprAtSystemGate: number | null;
  recallAt10AtSystemGate: number | null;
}

export interface LatencyStats {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  throughputPerSec: number;
}

export interface RandomBaseline {
  corpusSize: number;
  retrievalDepth: number;
  /** E[recall@k] for a uniformly random permutation over the same corpus. */
  recallAt: Record<number, number>;
  /** E[all gold inside top-k] for a uniformly random permutation. */
  allGoldAt: Record<number, number>;
  /** E[best gold rank], with gold beyond the depth cap charged corpusSize + 1. */
  meanRank: number;
  mrr: number;
}

export interface SystemReport {
  system: string;
  note?: string;
  status: "ok" | "error" | "skipped";
  error?: string;
  networkBound: boolean;
  corpusSize: number;
  overall: RankMetrics;
  perFamily: Record<string, RankMetrics>;
  abstention: AbstentionMetrics;
  ingest: { records: number; totalMs: number; recordsPerSec: number };
  search: LatencyStats;
  /** True when recall@10 is not convincingly above the analytic random baseline. */
  atOrBelowRandom: boolean;
  failedQueries: number;
}

function rankOf(ranking: RankedHit[], id: string): number {
  for (let i = 0; i < ranking.length; i++) if (ranking[i]!.id === id) return i + 1;
  return Number.POSITIVE_INFINITY;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Lower-tail quantile: quantile(xs, 0.1) is the value at or below which 10% of xs fall. */
function quantile(xs: number[], q: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx]!;
}

function percentile(xs: number[], p: number): number {
  const s = xs.slice().sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export function computeRankMetrics(
  label: string,
  items: EvalItem[],
  outcomes: Map<string, QueryOutcome>,
  corpusSize: number,
  ks: readonly number[] = DEFAULT_KS,
): RankMetrics {
  const answerable = items.filter((i) => i.goldMemoryIds.length > 0);
  const recallAt: Record<number, number> = {};
  const allGoldAt: Record<number, number> = {};
  const perItemRecall: Record<number, number[]> = {};
  const perItemAll: Record<number, number[]> = {};
  for (const k of ks) {
    perItemRecall[k] = [];
    perItemAll[k] = [];
  }
  const rrs: number[] = [];
  const ndcgs: number[] = [];
  const bestRanks: number[] = [];
  let found = 0;
  let staleWins = 0;
  let staleEligible = 0;

  const missPenalty = corpusSize + 1;

  for (const item of answerable) {
    const outcome = outcomes.get(item.id);
    const ranking = outcome?.ranking ?? [];
    const goldRanks = item.goldMemoryIds.map((g) => rankOf(ranking, g));
    const best = Math.min(...goldRanks);

    for (const k of ks) {
      const inTopK = goldRanks.filter((r) => r <= k).length;
      perItemRecall[k]!.push(inTopK / goldRanks.length);
      perItemAll[k]!.push(inTopK === goldRanks.length ? 1 : 0);
    }

    rrs.push(Number.isFinite(best) ? 1 / best : 0);
    ndcgs.push(ndcg(goldRanks, 10));
    bestRanks.push(Number.isFinite(best) ? best : missPenalty);
    if (Number.isFinite(best)) found++;

    const stale = item.supersededMemoryIds ?? [];
    if (stale.length > 0) {
      staleEligible++;
      const bestStale = Math.min(...stale.map((s) => rankOf(ranking, s)));
      if (bestStale < best) staleWins++;
    }
  }

  for (const k of ks) {
    recallAt[k] = mean(perItemRecall[k]!);
    allGoldAt[k] = mean(perItemAll[k]!);
  }

  return {
    family: label,
    n: answerable.length,
    recallAt,
    allGoldAt,
    mrr: mean(rrs),
    ndcgAt10: mean(ndcgs),
    meanRank: mean(bestRanks),
    medianRank: median(bestRanks),
    foundRate: answerable.length ? found / answerable.length : 0,
    staleRate: staleEligible > 0 ? staleWins / staleEligible : undefined,
  };
}

function ndcg(goldRanks: number[], k: number): number {
  let dcg = 0;
  for (const r of goldRanks) if (r <= k) dcg += 1 / Math.log2(r + 1);
  let ideal = 0;
  for (let i = 1; i <= Math.min(goldRanks.length, k); i++) ideal += 1 / Math.log2(i + 1);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function computeAbstentionMetrics(
  items: EvalItem[],
  outcomes: Map<string, QueryOutcome>,
  systemGate: number,
  targetRetention = 0.9,
): AbstentionMetrics {
  const answerable = items.filter((i) => i.goldMemoryIds.length > 0);
  const unanswerable = items.filter((i) => i.goldMemoryIds.length === 0);

  const top1 = (item: EvalItem): number => {
    const r = outcomes.get(item.id)?.ranking ?? [];
    return r.length > 0 ? r[0]!.score : Number.NEGATIVE_INFINITY;
  };

  const answerableTop1 = answerable.map(top1).filter((s) => Number.isFinite(s));
  const base: AbstentionMetrics = {
    nUnanswerable: unanswerable.length,
    nAnswerable: answerable.length,
    targetRetention,
    operatingThreshold: null,
    fprAtOperatingPoint: null,
    retentionAtOperatingPoint: null,
    systemGate,
    fprAtSystemGate: null,
    recallAt10AtSystemGate: null,
  };

  if (unanswerable.length > 0 && answerableTop1.length > 0) {
    const tau = quantile(answerableTop1, 1 - targetRetention);
    base.operatingThreshold = tau;
    base.fprAtOperatingPoint =
      unanswerable.filter((i) => top1(i) >= tau).length / unanswerable.length;
    base.retentionAtOperatingPoint =
      answerable.filter((i) => top1(i) >= tau).length / answerable.length;
  }

  // The system's own gate: FPR paired with the recall that survives it.
  if (unanswerable.length > 0) {
    base.fprAtSystemGate =
      unanswerable.filter((i) => (outcomes.get(i.id)?.ranking ?? []).some((h) => h.score >= systemGate)).length /
      unanswerable.length;
  }
  if (answerable.length > 0) {
    const gated = new Map<string, QueryOutcome>();
    for (const item of answerable) {
      const o = outcomes.get(item.id);
      if (!o) continue;
      gated.set(item.id, { ...o, ranking: o.ranking.filter((h) => h.score >= systemGate) });
    }
    base.recallAt10AtSystemGate = computeRankMetrics("gated", answerable, gated, 0, [10]).recallAt[10]!;
  }

  return base;
}

export function latencyStats(samples: number[]): LatencyStats {
  const total = samples.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    meanMs: mean(samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    throughputPerSec: total > 0 ? (samples.length / total) * 1000 : 0,
  };
}

/**
 * Closed-form expectation for a uniformly random ranking over the same corpus.
 * Printed next to every result so a system scoring at chance is impossible to miss.
 */
export function analyticRandomBaseline(
  items: EvalItem[],
  corpusSize: number,
  ks: readonly number[] = DEFAULT_KS,
  retrievalDepth = corpusSize,
): RandomBaseline {
  const answerable = items.filter((i) => i.goldMemoryIds.length > 0);
  const n = corpusSize;
  const depth = Math.min(retrievalDepth, n);

  /** P(best of g uniformly placed gold has rank >= j) = C(n-j+1, g) / C(n, g). */
  const pAtLeast = (j: number, g: number): number => {
    let p = 1;
    for (let t = 0; t < g; t++) {
      const num = n - j + 1 - t;
      if (num <= 0) return 0;
      p *= num / (n - t);
    }
    return p;
  };

  const recallAt: Record<number, number> = {};
  const allGoldAt: Record<number, number> = {};
  for (const k of ks) {
    recallAt[k] = n > 0 ? Math.min(1, k / n) : 0;
    // E[all g gold inside top-k] = C(k, g) / C(n, g), averaged over the item mix.
    allGoldAt[k] = mean(
      answerable.map((i) => {
        let p = 1;
        for (let t = 0; t < i.goldMemoryIds.length; t++) p *= (k - t) / (n - t);
        return Math.max(0, p);
      }),
    );
  }

  const meanRanks: number[] = [];
  const mrrs: number[] = [];
  for (const item of answerable) {
    const g = item.goldMemoryIds.length;
    // E[X] = sum_{j=1..d} P(X>=j) + (n+1-d) * P(X>d), with X capped at the depth limit.
    let sumTail = 0;
    let mrr = 0;
    for (let j = 1; j <= depth; j++) {
      const atLeastJ = pAtLeast(j, g);
      sumTail += atLeastJ;
      mrr += (atLeastJ - pAtLeast(j + 1, g)) / j;
    }
    meanRanks.push(sumTail + (n + 1 - depth) * pAtLeast(depth + 1, g));
    mrrs.push(mrr);
  }

  return {
    corpusSize: n,
    retrievalDepth: depth,
    recallAt,
    allGoldAt,
    meanRank: mean(meanRanks),
    mrr: mean(mrrs),
  };
}

export function familyOrder(): readonly Family[] {
  return FAMILIES;
}
