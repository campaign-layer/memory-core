import { postJson, type RetryOptions } from "./http.js";
import { tokenize } from "./tokenize.js";
import type { Tokenizer } from "./types.js";

export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Cosine similarity. Never clamps: negative similarity is real signal. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine dim mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** In-place L2 normalization; zero vectors are left alone. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  if (sum === 0) return vector;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) vector[i] *= inv;
  return vector;
}

function fnv1a(text: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface HashEmbedderOptions {
  dims?: number;
  tokenizer?: Tokenizer;
  /** 1 + ln(tf) instead of raw counts. Default true. */
  sublinearTf?: boolean;
}

/**
 * Signed feature-hashing bag-of-words embedder. LEXICAL, NOT SEMANTIC: cosine
 * here measures (stemmed) token overlap, nothing more. It is deterministic and
 * offline, which makes it the honest default for tests and CI. Two unrelated
 * strings score ~0 rather than ~1, which is the bug this replaces.
 */
export class HashEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  private readonly tokenizer: Tokenizer;
  private readonly sublinearTf: boolean;

  constructor(options: HashEmbedderOptions = {}) {
    this.dims = options.dims ?? 512;
    this.tokenizer = options.tokenizer ?? tokenize;
    this.sublinearTf = options.sublinearTf !== false;
    this.id = `hash-bow-${this.dims}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }

  embedOne(text: string): Float32Array {
    const counts = new Map<string, number>();
    for (const token of this.tokenizer(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    const vector = new Float32Array(this.dims);
    for (const [token, tf] of counts) {
      const hash = fnv1a(token);
      const bucket = hash % this.dims;
      const sign = fnv1a(token, 0x9dc5811c) & 1 ? -1 : 1;
      const weight = this.sublinearTf ? 1 + Math.log(tf) : tf;
      vector[bucket] += sign * weight;
    }
    return l2Normalize(vector);
  }
}

type FeatureExtractor = (
  texts: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<{ data: unknown; dims: number[] }>;

export interface LocalOnnxEmbedderOptions {
  model?: string;
  dims?: number;
  batchSize?: number;
  /** onnxruntime weight precision, e.g. "fp32" (default) or "q8". */
  dtype?: string;
  /** Prefix prepended to every text, e.g. a BGE query instruction. */
  prefix?: string;
}

/**
 * Default embedder: local ONNX sentence encoder via @huggingface/transformers.
 * Zero-config and offline after the first ~35MB model download. The pipeline is
 * lazy-loaded and cached, so constructing this class costs nothing.
 */
export class LocalOnnxEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  private readonly model: string;
  private readonly batchSize: number;
  private readonly dtype?: string;
  private readonly prefix: string;
  private pipelinePromise?: Promise<FeatureExtractor>;

  constructor(options: LocalOnnxEmbedderOptions = {}) {
    this.model = options.model ?? "Xenova/bge-small-en-v1.5";
    this.dims = options.dims ?? 384;
    this.batchSize = options.batchSize ?? 16;
    this.dtype = options.dtype;
    this.prefix = options.prefix ?? "";
    this.id = `onnx:${this.model}`;
  }

  /** Optional warm-up; embed() loads on demand anyway. */
  async load(): Promise<void> {
    await this.extractor();
  }

  private extractor(): Promise<FeatureExtractor> {
    // Cache the promise, not the result, so concurrent callers share one load.
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        // Indirect specifier on purpose: @huggingface/transformers is an
        // optionalDependency (it pulls ~450MB of onnxruntime), so the build must
        // typecheck without it installed. Services that never construct this
        // class — the file/postgres HTTP server — never load it.
        const specifier = "@huggingface/transformers";
        let mod: { pipeline: (...args: unknown[]) => Promise<unknown> };
        try {
          mod = (await import(specifier)) as typeof mod;
        } catch (cause) {
          throw new Error(
            `LocalOnnxEmbedder requires the optional dependency "@huggingface/transformers". ` +
              `Install it with: npm install @huggingface/transformers`,
            { cause },
          );
        }
        const options = this.dtype ? { dtype: this.dtype as never } : undefined;
        const extractor = await mod.pipeline("feature-extraction", this.model, options);
        return extractor as unknown as FeatureExtractor;
      })().catch((error) => {
        this.pipelinePromise = undefined;
        throw error;
      });
    }
    return this.pipelinePromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.extractor();
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts
        .slice(i, i + this.batchSize)
        .map((text) => this.prefix + (text.trim() || " "));
      // The pipeline mean-pools and L2-normalizes; we re-normalize defensively.
      const tensor = await extractor(batch, { pooling: "mean", normalize: true });
      const data = tensor.data as Float32Array;
      const width = tensor.dims[tensor.dims.length - 1];
      if (width !== this.dims) {
        throw new Error(`${this.id} returned ${width} dims, expected ${this.dims}`);
      }
      for (let row = 0; row < batch.length; row++) {
        out.push(l2Normalize(Float32Array.from(data.subarray(row * width, (row + 1) * width))));
      }
    }
    return out;
  }
}

interface HostedEmbedderOptions {
  model?: string;
  apiKey?: string;
  batchSize?: number;
  retry?: RetryOptions;
  dims?: number;
}

interface EmbeddingApiResponse {
  data: Array<{ index?: number; embedding: number[] }>;
}

function requireKey(key: string | undefined, envVar: string, provider: string): string {
  if (!key) {
    throw new Error(`${provider} requires an API key: set ${envVar} or pass apiKey.`);
  }
  return key;
}

function toVectors(response: EmbeddingApiResponse, expected: number, dims: number): Float32Array[] {
  const rows = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== expected) {
    throw new Error(`embedding API returned ${rows.length} vectors, expected ${expected}`);
  }
  return rows.map((row) => {
    if (row.embedding.length !== dims) {
      throw new Error(`embedding API returned ${row.embedding.length} dims, expected ${dims}`);
    }
    return l2Normalize(Float32Array.from(row.embedding));
  });
}

/** Voyage AI embeddings (default voyage-3, 1024 dims). Key-gated. */
export class VoyageEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly batchSize: number;
  private readonly retry?: RetryOptions;
  private readonly inputType?: "query" | "document";

  constructor(options: HostedEmbedderOptions & { inputType?: "query" | "document" } = {}) {
    this.model = options.model ?? "voyage-3";
    this.dims = options.dims ?? 1024;
    this.apiKey = options.apiKey ?? process.env.VOYAGE_API_KEY;
    this.batchSize = options.batchSize ?? 128;
    this.retry = options.retry;
    this.inputType = options.inputType;
    this.id = `voyage:${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const key = requireKey(this.apiKey, "VOYAGE_API_KEY", "VoyageEmbedder");
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await postJson<EmbeddingApiResponse>(
        "https://api.voyageai.com/v1/embeddings",
        { model: this.model, input: batch, input_type: this.inputType },
        { authorization: `Bearer ${key}` },
        this.retry,
      );
      out.push(...toVectors(response, batch.length, this.dims));
    }
    return out;
  }
}

/** OpenAI embeddings (default text-embedding-3-large, 3072 dims). Key-gated. */
export class OpenAIEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly batchSize: number;
  private readonly retry?: RetryOptions;
  private readonly baseUrl: string;

  constructor(options: HostedEmbedderOptions & { baseUrl?: string } = {}) {
    this.model = options.model ?? "text-embedding-3-large";
    this.dims = options.dims ?? 3072;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.batchSize = options.batchSize ?? 128;
    this.retry = options.retry;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.id = `openai:${this.model}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const key = requireKey(this.apiKey, "OPENAI_API_KEY", "OpenAIEmbedder");
    const out: Float32Array[] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const response = await postJson<EmbeddingApiResponse>(
        `${this.baseUrl}/embeddings`,
        { model: this.model, input: batch, dimensions: this.dims },
        { authorization: `Bearer ${key}` },
        this.retry,
      );
      out.push(...toVectors(response, batch.length, this.dims));
    }
    return out;
  }
}

/** Backends `createEmbedder` can build. `none` disables semantic retrieval. */
export type EmbedderKind = "none" | "local" | "hash" | "voyage" | "openai";

export interface EmbedderSpec {
  kind: EmbedderKind;
  /** Backend model id. Each kind keeps its own default when omitted. */
  model?: string;
  /** Output width. REQUIRED with a non-default model, whose width we cannot infer. */
  dims?: number;
}

/**
 * Builds an embedder from a declarative spec (see config.ts for the env parse).
 * Construction is deliberately cheap for every kind — LocalOnnxEmbedder loads
 * its pipeline lazily and the hosted ones only read a key — so a service can
 * build one at boot without paying for a model it may never query.
 *
 * Not wrapped in CachedEmbedder on purpose: providers keep document vectors for
 * the process lifetime, so the only repeat text would be an identical query,
 * and a cache filled by ingest would evict those anyway.
 */
export function createEmbedder(spec: EmbedderSpec): EmbeddingProvider | null {
  switch (spec.kind) {
    case "none":
      return null;
    case "hash":
      // Lexical, not semantic: use it for deterministic offline tests, not to
      // beat a lexical ranker it shares a signal with.
      return new HashEmbedder({ dims: spec.dims });
    case "local":
      return new LocalOnnxEmbedder({ model: spec.model, dims: spec.dims });
    case "voyage":
      return new VoyageEmbedder({ model: spec.model, dims: spec.dims });
    case "openai":
      return new OpenAIEmbedder({ model: spec.model, dims: spec.dims });
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`unknown embedder kind: ${String(exhaustive)}`);
    }
  }
}

/** Wraps any provider with an unbounded-by-default in-process cache. */
export class CachedEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dims: number;
  private readonly cache = new Map<string, Float32Array>();

  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly maxEntries = 10_000,
  ) {
    this.id = `cached:${inner.id}`;
    this.dims = inner.dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const pending = new Set<string>();
    for (const text of texts) {
      if (!this.cache.has(text)) pending.add(text);
    }
    if (pending.size > 0) {
      const missing = [...pending];
      const vectors = await this.inner.embed(missing);
      missing.forEach((text, i) => this.put(text, vectors[i]));
    }
    return texts.map((text) => this.cache.get(text) ?? new Float32Array(this.dims));
  }

  private put(text: string, vector: Float32Array): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(text, vector);
  }
}
