/**
 * Systems under test. All of them are the repo's own code driven through one
 * ingest -> search path, so the comparison is same-harness by construction.
 *
 *   bm25                   -> memory-core/bench/systems/bm25.ts  (lexical reference point)
 *   memory-core            -> src/providers/factory.ts, kind=in-memory, embedder none (BM25-only)
 *   memory-core-hybrid-k5  -> same provider + LocalOnnxEmbedder, RRF k=5
 *   memory-core-hybrid-k60 -> same provider + LocalOnnxEmbedder, RRF k=60 (the current default)
 *   random                 -> memory-core/bench/systems/random.ts (mandatory sanity floor)
 *   mc-enhanced / mc-dual-layer -> the other offline provider kinds in the checkout
 */
import { createBm25System } from "../systems/bm25.js";
import { createRandomSystem } from "../systems/random.js";
import {
  BENCH_ACTOR, BENCH_APP, BENCH_TENANT, toMemoryRecord,
  type BenchSystem, type MaterializedMemory, type RankedHit,
} from "../types.js";
import { createMemoryProvider, type MemoryProviderKind } from "../../src/providers/factory.js";
import type { MemoryProvider } from "../../src/provider.js";
import { CachedEmbedder, createEmbedder } from "../../src/retrieval/embedder.js";

/** InMemoryProvider clamps `limit` to 100, so 100 is the deepest honest ranking. */
export const RETRIEVAL_DEPTH = 100;

/** Declarative spec, exactly as config.ts would build it from MEMORY_EMBEDDER=local. */
export const HYBRID_EMBEDDER_SPEC = { kind: "local" as const };

export const SYSTEM_KINDS: Record<string, MemoryProviderKind> = {
  "memory-core": "in-memory",
  "mc-enhanced": "enhanced",
  "mc-dual-layer": "dual-layer",
};

export const HYBRID_RRF_K: Record<string, number> = {
  "memory-core-hybrid-k5": 5,
  "memory-core-hybrid-k60": 60,
};

export const ALL_SYSTEMS = [
  "bm25", "memory-core", "memory-core-hybrid-k5", "memory-core-hybrid-k60",
  "random", "mc-enhanced", "mc-dual-layer",
] as const;

/**
 * The retrieval configuration behind a system name, for report labels.
 *
 * `memory-core` is BM25-only: the factory gets no embedder, so the vector leg never
 * runs. It is a DIFFERENT configuration from `memory-core-hybrid-*`, measured on a
 * different question set, and the two must never be presented as one row. This
 * function exists so the distinction is printed rather than remembered.
 */
export function retrievalConfigLabel(name: string): string {
  if (name === "bm25") return "Okapi BM25 reference, lexical only";
  if (name === "random") return "seeded shuffle control";
  if (name in HYBRID_RRF_K) {
    return `hybrid BM25 + local ONNX vector, RRF k=${HYBRID_RRF_K[name]}`;
  }
  const kind = SYSTEM_KINDS[name];
  if (kind) return `provider kind=${kind}, embedder=none (BM25-only)`;
  return "unknown configuration";
}

/** Per-search evidence that the vector leg actually ran. */
export interface SearchDiag {
  hits: number;
  vectorCredited: number;
  /** Documents with a stored vector after ingest, vs the corpus size. */
  storedVectors: number | null;
  corpusSize: number | null;
  sampleReasons: string[];
}

export interface DiagSystem extends BenchSystem {
  diag?: SearchDiag;
}

/**
 * One embedder per PROCESS, wrapped in the repo's CachedEmbedder.
 *
 * Two reasons, both load-bearing:
 *  - loading the ONNX model costs ~7s, so it must not happen per question.
 *  - rrfK only changes fusion at search time, never the vectors. Caching text->vector
 *    means the k=5 and k=60 variants share ONE embedding pass over each corpus
 *    instead of paying ~30s/question twice.
 *
 * This is passed as factory option `embedder`, which the factory documents as
 * "a ready instance, takes precedence over embedderSpec". It is the same class and
 * config that embedderSpec {kind:"local"} constructs - preflight.ts asserts the two
 * routes produce byte-identical rankings.
 */
let sharedEmbedder: any = null;
export function getSharedEmbedder(): any {
  if (!sharedEmbedder) {
    const inner = createEmbedder(HYBRID_EMBEDDER_SPEC);
    if (!inner) throw new Error(`embedder spec ${JSON.stringify(HYBRID_EMBEDDER_SPEC)} resolved to null`);
    // 60k entries covers ~120 corpora of ~500 turns before eviction.
    sharedEmbedder = new CachedEmbedder(inner, 60_000);
  }
  return sharedEmbedder;
}

/**
 * Wraps a real MemoryProvider. Differs from bench/systems/provider.ts only in
 * that it puts the session date on `metadata.sessionDate` as well as on the
 * record timestamps, because temporal-reasoning questions need the date to be
 * carried on the memory. minScore is 0 so the metrics measure RANKING, not a gate.
 */
function providerSystem(
  name: string,
  kind: MemoryProviderKind,
  opts: { embedder?: any; rrfK?: number } = {},
): DiagSystem {
  let provider: MemoryProvider | null = null;

  const system: DiagSystem = {
    name,
    note: opts.embedder
      ? `src/providers/factory.ts (kind=${kind}, embedder=${opts.embedder.id}, rrfK=${opts.rrfK})`
      : `src/providers/factory.ts (kind=${kind}, embedder=none)`,
    defaultMinScore: 0,

    async setup() {
      // Fresh provider per call => one corpus per question, no cross-question bleed.
      provider = createMemoryProvider({ kind, embedder: opts.embedder ?? undefined, rrfK: opts.rrfK });
    },

    async ingest(memories: MaterializedMemory[]) {
      if (!provider) throw new Error("setup() not called");
      const records = memories.map((m) => {
        const record = toMemoryRecord(m);
        record.metadata = { ...record.metadata, sessionDate: m.timestampIso };
        return record;
      });
      // ingest() awaits embedding internally, so search is warm on return. We never
      // call restore(), which is the path that backfills vectors in the background.
      await provider.ingest(records);
    },

    async search(query: string, k: number): Promise<RankedHit[]> {
      if (!provider) throw new Error("setup() not called");
      const hits: any[] = await provider.search({
        query,
        filters: { tenantId: BENCH_TENANT, appId: BENCH_APP, actorId: BENCH_ACTOR },
        limit: k,
        minScore: 0,
      });
      // Liveness evidence: the provider degrades to BM25-only BY DESIGN if the model
      // fails to load, and that would look like a real hybrid result. Record how many
      // hits carry a vector credit so the report can prove the vector leg ran.
      let credited = 0;
      for (const h of hits) {
        if (Array.isArray(h.reasons) && h.reasons.some((r: string) => /vector/i.test(r))) credited++;
      }
      const p: any = provider;
      system.diag = {
        hits: hits.length,
        vectorCredited: credited,
        // Reading the provider's own vector store: "N of N documents embedded" is the
        // strongest available proof that ingest() finished embedding before search.
        storedVectors: p.vectors instanceof Map ? p.vectors.size : null,
        corpusSize: p.records instanceof Map ? p.records.size : null,
        sampleReasons: Array.isArray(hits[0]?.reasons) ? hits[0].reasons.slice(0, 4) : [],
      };

      // Abort rather than report BM25 numbers under a hybrid label. Degrading to
      // BM25-only when the embedder fails is intended provider behaviour, so this
      // is the only thing standing between a broken model load and a fake result.
      if (opts.embedder) {
        const d = system.diag;
        if (!d.storedVectors) {
          throw new Error(`LIVENESS ${name}: embedder configured but ${d.storedVectors} stored vectors`);
        }
        if (d.corpusSize && d.storedVectors < d.corpusSize) {
          throw new Error(`LIVENESS ${name}: only ${d.storedVectors}/${d.corpusSize} documents embedded`);
        }
        if (credited === 0 && hits.length > 0) {
          throw new Error(`LIVENESS ${name}: no hit carries a vector credit - silently degraded to BM25-only`);
        }
      }
      return hits.map((h) => ({ id: h.memory.id, score: h.score }));
    },

    async teardown() {
      await provider?.close?.();
      provider = null;
    },
  };

  return system;
}

export function buildSystem(name: string, seed: number): DiagSystem {
  if (name === "bm25") return createBm25System();
  if (name === "random") return createRandomSystem(seed);
  if (name in HYBRID_RRF_K) {
    return providerSystem(name, "in-memory", { embedder: getSharedEmbedder(), rrfK: HYBRID_RRF_K[name] });
  }
  const kind = SYSTEM_KINDS[name];
  if (!kind) throw new Error(`unknown system: ${name}`);
  return providerSystem(name, kind);
}
