import { cosine } from "./embedder.js";
import { minMax } from "./fusion.js";
import type { Scored } from "./types.js";

export type VectorLookup = Map<string, Float32Array> | ((id: string) => Float32Array | undefined);

function lookup(source: VectorLookup, id: string): Float32Array | undefined {
  return typeof source === "function" ? source(id) : source.get(id);
}

/**
 * Maximal Marginal Relevance. Greedily picks the candidate maximizing
 * lambda * relevance - (1 - lambda) * maxSimilarityToAlreadySelected.
 *
 * Relevance is min-max normalized across candidates so lambda trades off two
 * comparable [0,1]-ish quantities. Returned hits keep their ORIGINAL relevance
 * score; the array order is the MMR selection order and is what carries the
 * diversification. Candidates without a vector get no diversity penalty.
 */
export function mmr(
  candidates: Scored[],
  embeddings: VectorLookup,
  lambda = 0.7,
  k = 10,
): Scored[] {
  if (candidates.length === 0 || k <= 0) return [];
  if (lambda >= 1) return candidates.slice(0, k);

  const relevance = new Map(minMax(candidates).map((hit) => [hit.id, hit.score]));
  const pool = [...candidates];
  const selected: Scored[] = [];
  const selectedVectors: Float32Array[] = [];

  while (selected.length < k && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const vector = lookup(embeddings, pool[i].id);
      let penalty = 0;
      if (vector) {
        for (const other of selectedVectors) {
          if (other.length !== vector.length) continue;
          penalty = Math.max(penalty, cosine(vector, other));
        }
      }
      const value = lambda * (relevance.get(pool[i].id) ?? 0) - (1 - lambda) * penalty;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    const [chosen] = pool.splice(bestIndex, 1);
    selected.push(chosen);
    const vector = lookup(embeddings, chosen.id);
    if (vector) selectedVectors.push(vector);
  }

  return selected;
}
