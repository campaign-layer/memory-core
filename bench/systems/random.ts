/**
 * Sanity floor. Non-negotiable: this is the control that catches a scorer whose
 * ranking carries no information. Deterministic per (seed, query).
 */
import { Rng, hashString } from "../rng.js";
import type { BenchSystem, MaterializedMemory, RankedHit } from "../types.js";

export function createRandomSystem(seed: number): BenchSystem {
  let ids: string[] = [];

  return {
    name: "random",
    note: `seeded shuffle control (seed=${seed})`,
    defaultMinScore: 0,

    async ingest(memories: MaterializedMemory[]) {
      ids = memories.map((m) => m.id);
    },

    async search(query: string, k: number): Promise<RankedHit[]> {
      const rng = new Rng(hashString(`${seed}:${query}`));
      const shuffled = rng.shuffle(ids).slice(0, k);
      // Descending synthetic scores so gate-based metrics stay well defined.
      return shuffled.map((id, i) => ({ id, score: 1 - i / Math.max(1, shuffled.length) }));
    },
  };
}
