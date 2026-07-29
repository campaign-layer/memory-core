import type { Scored } from "./types.js";

function sortedCopy(list: Scored[]): Scored[] {
  return [...list].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/**
 * Reciprocal Rank Fusion: score = sum_i weight_i / (k + rank_i), rank starting
 * at 1. Rank-only, so incomparable score scales (BM25 vs cosine) do not need
 * calibration. Input lists are re-sorted defensively.
 */
export function rrf(rankedLists: Scored[][], k = 60, weights?: number[]): Scored[] {
  const fused = new Map<string, number>();

  rankedLists.forEach((list, listIndex) => {
    const weight = weights?.[listIndex] ?? 1;
    if (weight === 0) return;
    sortedCopy(list).forEach((hit, index) => {
      fused.set(hit.id, (fused.get(hit.id) ?? 0) + weight / (k + index + 1));
    });
  });

  return sortedCopy([...fused].map(([id, score]) => ({ id, score })));
}

/** Min-max rescale to [0,1]. All-equal lists collapse to 1. */
export function minMax(list: Scored[]): Scored[] {
  if (list.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const hit of list) {
    if (hit.score < min) min = hit.score;
    if (hit.score > max) max = hit.score;
  }
  const span = max - min;
  return list.map((hit) => ({ id: hit.id, score: span === 0 ? 1 : (hit.score - min) / span }));
}

/** Standard-score rescale. Zero-variance lists collapse to 0. */
export function zScore(list: Scored[]): Scored[] {
  if (list.length === 0) return [];
  const mean = list.reduce((sum, hit) => sum + hit.score, 0) / list.length;
  const variance = list.reduce((sum, hit) => sum + (hit.score - mean) ** 2, 0) / list.length;
  const sd = Math.sqrt(variance);
  return list.map((hit) => ({ id: hit.id, score: sd === 0 ? 0 : (hit.score - mean) / sd }));
}

export interface LinearFusionOptions {
  weights?: number[];
  normalize?: "minmax" | "zscore" | "none";
  /** Score used for a document absent from a list. Defaults to 0. */
  missing?: number;
}

/**
 * Score-normalized weighted-sum fusion. Keeps score magnitude, which RRF
 * throws away, at the cost of being sensitive to outliers in each list.
 */
export function linearFusion(rankedLists: Scored[][], options: LinearFusionOptions = {}): Scored[] {
  const mode = options.normalize ?? "minmax";
  const missing = options.missing ?? 0;

  const normalized = rankedLists.map((list) => {
    if (mode === "minmax") return minMax(list);
    if (mode === "zscore") return zScore(list);
    return list;
  });

  const ids = new Set<string>();
  for (const list of normalized) for (const hit of list) ids.add(hit.id);

  const lookups = normalized.map((list) => new Map(list.map((hit) => [hit.id, hit.score])));
  const fused: Scored[] = [];
  for (const id of ids) {
    let score = 0;
    lookups.forEach((lookup, listIndex) => {
      score += (options.weights?.[listIndex] ?? 1) * (lookup.get(id) ?? missing);
    });
    fused.push({ id, score });
  }
  return sortedCopy(fused);
}
