/**
 * Embedding backend for the naive-rag baseline.
 *
 * Prefers src/retrieval/embedder.ts if the retrieval work lands there, so naive-rag
 * and the hybrid system share one embedding backend and the comparison isolates
 * retrieval STRATEGY rather than embedding quality. Falls back to a bench-local
 * HashEmbedder of the same shape when that module is absent.
 */
import { hashString } from "./rng.js";
import { tokenize } from "./tokenize.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * Deterministic, offline, no model download. Signed feature hashing over unigrams
 * and bigrams with sublinear tf, L2-normalized.
 *
 * IMPORTANT: a hashing embedder has no semantic generalization. naive-rag on this
 * backend is effectively a dense lexical baseline and says nothing about how a real
 * sentence encoder would score. See bench/README.md.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly name: string;

  constructor(readonly dimensions = 256) {
    this.name = `hash-${dimensions}d`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    const features: string[] = tokens.slice();
    for (let i = 0; i + 1 < tokens.length; i++) features.push(`${tokens[i]}_${tokens[i + 1]}`);

    const counts = new Map<string, number>();
    for (const f of features) counts.set(f, (counts.get(f) ?? 0) + 1);

    for (const [feature, count] of counts) {
      const h = hashString(feature);
      const bucket = h % this.dimensions;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vec[bucket] = vec[bucket]! + sign * (1 + Math.log(count));
    }

    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
    return vec;
  }
}

/** Real sentence encoder. Requires a model download on first use; opt-in only. */
export class TransformersEmbedder implements EmbeddingProvider {
  readonly name: string;
  dimensions = 384;
  private pipe: unknown = null;

  constructor(private readonly modelId = "Xenova/all-MiniLM-L6-v2") {
    this.name = `transformers:${modelId}`;
  }

  private async ensure(): Promise<any> {
    if (this.pipe) return this.pipe;
    // Keep the opt-in encoder out of the static module graph so clean runtime
    // installs that intentionally omit optional dependencies still typecheck.
    const specifier = "@huggingface/transformers";
    const mod: any = await import(specifier);
    this.pipe = await mod.pipeline("feature-extraction", this.modelId, { dtype: "fp32" });
    return this.pipe;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const pipe: any = await this.ensure();
    const out: Float32Array[] = [];
    for (const text of texts) {
      const res = await pipe(text, { pooling: "mean", normalize: true });
      out.push(Float32Array.from(res.data as ArrayLike<number>));
      this.dimensions = res.data.length;
    }
    return out;
  }
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export interface EmbedderChoice {
  provider: EmbeddingProvider;
  /** True when src/retrieval/embedder.ts supplied it. Recorded in the run JSON. */
  fromSrc: boolean;
}

export type EmbedderKind = "hash" | "bench-hash" | "minilm";

/**
 * src/retrieval/embedder.ts declares the same interface with different property names
 * (`id`/`dims` rather than `name`/`dimensions`). Adapt rather than cast, or the run
 * report prints `embedder=undefined`.
 */
function adaptSrcProvider(instance: any): EmbeddingProvider {
  return {
    name: `src:${instance.id ?? instance.name ?? "unknown"}`,
    dimensions: instance.dims ?? instance.dimensions ?? 0,
    embed: (texts: string[]) => instance.embed(texts),
  };
}

/**
 * `hash` prefers src/retrieval/embedder.ts so naive-rag and the hybrid system share one
 * embedding backend and the comparison isolates retrieval strategy. `bench-hash` forces
 * the frozen bench-local embedder, which is useful when src is being actively changed and
 * you need a baseline that cannot move underneath you. Never throws.
 */
export async function resolveEmbedder(kind: EmbedderKind): Promise<EmbedderChoice> {
  if (kind === "minilm") return { provider: new TransformersEmbedder(), fromSrc: false };
  if (kind === "bench-hash") return { provider: new HashEmbedder(256), fromSrc: false };

  try {
    const mod: any = await import("../src/retrieval/embedder.js");
    const Ctor = mod.HashEmbedder ?? mod.default?.HashEmbedder;
    if (typeof Ctor === "function") {
      const instance = new Ctor();
      if (typeof instance.embed === "function") {
        return { provider: adaptSrcProvider(instance), fromSrc: true };
      }
    }
  } catch {
    // src/retrieval/embedder.ts absent or not importable; fall back below.
  }
  return { provider: new HashEmbedder(256), fromSrc: false };
}
