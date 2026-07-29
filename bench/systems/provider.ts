/**
 * Drives any MemoryProvider from src/provider.ts through the same ingest -> search
 * path as every other system, so comparisons are apples-to-apples by construction.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { createMemoryProvider, type MemoryProviderKind } from "../../src/providers/factory.js";
import type { MemoryProvider } from "../../src/provider.js";
import {
  BENCH_ACTOR, BENCH_APP, BENCH_TENANT,
  toMemoryRecord,
  type BenchSystem, type MaterializedMemory, type RankedHit, type SystemContext,
} from "../types.js";

/**
 * Score gates each provider applies by default (src/providers/*.ts). We search with
 * minScore 0 so ranking metrics measure ranking rather than an arbitrary cutoff, then
 * re-apply the gate client-side for the abstention operating point.
 */
const DEFAULT_GATES: Record<string, number> = {
  "in-memory": 0.2,
  file: 0.2,
  enhanced: 0.05,
  "dual-layer": 0.05,
};

export function createProviderSystem(kind: MemoryProviderKind, ctx: SystemContext): BenchSystem {
  let provider: MemoryProvider | null = null;
  const storePath = path.join(ctx.workDir, `provider-${kind}.json`);

  return {
    name: kind,
    note: `src/providers via factory (kind=${kind})`,
    defaultMinScore: DEFAULT_GATES[kind] ?? 0,

    async setup() {
      if (kind === "file") rmSync(storePath, { force: true });
      provider = createMemoryProvider({ kind, filePath: storePath });
    },

    async ingest(memories: MaterializedMemory[]) {
      if (!provider) throw new Error("setup() not called");
      await provider.ingest(memories.map(toMemoryRecord));
    },

    async search(query: string, k: number): Promise<RankedHit[]> {
      if (!provider) throw new Error("setup() not called");
      const hits = await provider.search({
        query,
        filters: { tenantId: BENCH_TENANT, appId: BENCH_APP, actorId: BENCH_ACTOR },
        limit: k,
        minScore: 0,
      });
      return hits.map((h) => ({ id: h.memory.id, score: h.score }));
    },

    async teardown() {
      if (kind === "file") rmSync(storePath, { force: true });
      provider = null;
    },
  };
}
