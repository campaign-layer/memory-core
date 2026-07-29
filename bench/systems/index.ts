import { resolveEmbedder, type EmbedderKind } from "../embedder.js";
import type { BenchSystem, SystemContext } from "../types.js";
import { createBm25System } from "./bm25.js";
import { createNaiveRagSystem } from "./naive-rag.js";
import { createProviderSystem } from "./provider.js";
import { createRandomSystem } from "./random.js";
import { createSupermemorySystem } from "./supermemory.js";

export const KNOWN_SYSTEMS = [
  "in-memory", "file", "enhanced", "dual-layer",
  "bm25", "random", "naive-rag", "supermemory",
] as const;

export type SystemName = (typeof KNOWN_SYSTEMS)[number];

/** Runs by default. dual-layer and supermemory are opt-in via --systems. */
export const DEFAULT_SYSTEMS: SystemName[] = [
  "in-memory", "file", "enhanced", "bm25", "random", "naive-rag",
];

export interface BuiltSystem {
  system: BenchSystem;
  /** Recorded in the run JSON so a reader knows which embedder produced the numbers. */
  embedderFromSrc?: boolean;
}

export async function buildSystem(name: SystemName, ctx: SystemContext): Promise<BuiltSystem> {
  switch (name) {
    case "in-memory":
    case "file":
    case "enhanced":
    case "dual-layer":
      return { system: createProviderSystem(name, ctx) };
    case "bm25":
      return { system: createBm25System() };
    case "random":
      return { system: createRandomSystem(ctx.seed) };
    case "naive-rag": {
      const choice = await resolveEmbedder(ctx.embedderName as EmbedderKind);
      return { system: createNaiveRagSystem(choice.provider), embedderFromSrc: choice.fromSrc };
    }
    case "supermemory":
      return { system: createSupermemorySystem({ containerTag: `mcir-${ctx.runId}` }) };
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown system: ${String(exhaustive)}`);
    }
  }
}
