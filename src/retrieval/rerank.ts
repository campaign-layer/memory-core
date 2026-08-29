import { postJson, type RetryOptions } from "./http.js";
import type { Scored, TextDoc } from "./types.js";

export interface Reranker {
  readonly id: string;
  rerank(query: string, docs: TextDoc[], topK: number): Promise<Scored[]>;
}

/** Backends `createReranker` can build. `none` preserves provider-native ranking. */
export type RerankerKind = "none" | "voyage";

export interface RerankerSpec {
  kind: RerankerKind;
  model?: string;
}

/** Keeps the incoming order; scores decay by position so they stay sortable. */
export class NoopReranker implements Reranker {
  readonly id = "noop";

  async rerank(_query: string, docs: TextDoc[], topK: number): Promise<Scored[]> {
    return docs.slice(0, Math.max(0, topK)).map((doc, i) => ({ id: doc.id, score: 1 / (1 + i) }));
  }
}

export interface VoyageRerankerOptions {
  model?: string;
  apiKey?: string;
  retry?: RetryOptions;
  /** Max docs sent in one request. */
  batchSize?: number;
}

interface VoyageRerankResponse {
  data: Array<{ index: number; relevance_score: number }>;
}

/** Voyage cross-encoder rerank (default rerank-2.5). Key-gated. */
export class VoyageReranker implements Reranker {
  readonly id: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly retry?: RetryOptions;
  private readonly batchSize: number;

  constructor(options: VoyageRerankerOptions = {}) {
    this.model = options.model ?? "rerank-2.5";
    this.apiKey = options.apiKey ?? process.env.VOYAGE_API_KEY;
    // This sits synchronously on the read path. The generic hosted-client
    // defaults can spend minutes across retries; fail open through the service
    // circuit breaker after one bounded attempt instead.
    this.retry = options.retry ?? { maxRetries: 0, timeoutMs: 5_000 };
    this.batchSize = options.batchSize ?? 100;
    this.id = `voyage:${this.model}`;
  }

  async rerank(query: string, docs: TextDoc[], topK: number): Promise<Scored[]> {
    if (docs.length === 0 || topK <= 0) return [];
    if (!this.apiKey) {
      throw new Error("VoyageReranker requires an API key: set VOYAGE_API_KEY or pass apiKey.");
    }

    const all: Scored[] = [];
    for (let i = 0; i < docs.length; i += this.batchSize) {
      const batch = docs.slice(i, i + this.batchSize);
      const response = await postJson<VoyageRerankResponse>(
        "https://api.voyageai.com/v1/rerank",
        {
          model: this.model,
          query,
          documents: batch.map((doc) => doc.text),
          top_k: Math.min(topK, batch.length),
          truncation: true,
        },
        { authorization: `Bearer ${this.apiKey}` },
        this.retry,
      );
      for (const row of response.data) {
        const doc = batch[row.index];
        if (doc) all.push({ id: doc.id, score: row.relevance_score });
      }
    }

    all.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return all.slice(0, topK);
  }
}

/** Cheap construction; the hosted backend does not make a request until rerank(). */
export function createReranker(spec: RerankerSpec): Reranker | null {
  switch (spec.kind) {
    case "none":
      return null;
    case "voyage":
      return new VoyageReranker({ model: spec.model });
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`unknown reranker kind: ${String(exhaustive)}`);
    }
  }
}
