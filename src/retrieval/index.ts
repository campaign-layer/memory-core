import { BM25Index, type Bm25Options } from "./bm25.js";
import { cosine, type EmbeddingProvider } from "./embedder.js";
import { linearFusion, rrf } from "./fusion.js";
import { mmr } from "./mmr.js";
import type { Reranker } from "./rerank.js";
import type { Scored, TextDoc, VectorSearchFn } from "./types.js";

export * from "./types.js";
export * from "./tokenize.js";
export * from "./bm25.js";
export * from "./embedder.js";
export * from "./fusion.js";
export * from "./mmr.js";
export * from "./rerank.js";
export { HttpDeadlineError, HttpError, postJson, type RetryOptions } from "./http.js";

export type Metadata = Record<string, unknown>;

export interface IndexDoc extends TextDoc {
  metadata?: Metadata;
  /** Precomputed vector; skips the embedder for this doc. */
  vector?: Float32Array;
}

/** Per-stage scores so a final ranking stays explainable. */
export interface RetrievalComponents {
  bm25?: number;
  vector?: number;
  fused?: number;
  rerank?: number;
}

export interface RetrievalHit {
  id: string;
  score: number;
  components: RetrievalComponents;
  reasons: string[];
  text?: string;
  metadata?: Metadata;
}

export interface HybridRetrieverOptions {
  embedder?: EmbeddingProvider;
  reranker?: Reranker;
  bm25?: Bm25Options;
  /** "rrf" (default) ignores score scale; "linear" keeps magnitude. */
  fusion?: "rrf" | "linear";
  rrfK?: number;
  weights?: { bm25?: number; vector?: number };
  /** Candidates pulled from each retriever before fusion. */
  candidateK?: number;
  /** MMR tradeoff; 1 (default) disables diversification. */
  mmrLambda?: number;
}

export interface SearchOptions {
  topK?: number;
  candidateK?: number;
  filter?: (id: string) => boolean;
  /** Externally computed lexical candidates; defaults to the internal BM25 index. */
  lexical?: Scored[];
  /** Externally computed vector candidates; skips embedding the query. */
  vectorCandidates?: Scored[];
  /** ANN callback; defaults to brute force over locally indexed vectors. */
  vectorSearch?: VectorSearchFn;
  queryEmbedding?: Float32Array;
  /** Text resolver for reranking when documents live elsewhere. */
  getText?: (id: string) => string | undefined;
  /** Vector resolver for MMR when vectors live elsewhere. */
  getVector?: (id: string) => Float32Array | undefined;
  mmrLambda?: number;
  /** Set false to skip a configured reranker for this query. */
  rerank?: boolean;
}

/**
 * Composes BM25 + vector search -> fusion -> optional rerank -> optional MMR.
 *
 * Storage-agnostic: it keeps an in-memory index for convenience, but every
 * stage can be fed from outside (candidate lists, an ANN callback, text/vector
 * resolvers), so a Postgres+pgvector provider can call in without this class
 * owning any persistence.
 */
export class HybridRetriever {
  readonly bm25: BM25Index;
  private readonly embedder?: EmbeddingProvider;
  private readonly reranker?: Reranker;
  private readonly fusionMode: "rrf" | "linear";
  private readonly rrfK: number;
  private readonly weights: [number, number];
  private readonly candidateK: number;
  private readonly defaultLambda: number;

  private readonly texts = new Map<string, string>();
  private readonly vectors = new Map<string, Float32Array>();
  private readonly metadata = new Map<string, Metadata>();

  constructor(options: HybridRetrieverOptions = {}) {
    this.bm25 = new BM25Index(options.bm25);
    this.embedder = options.embedder;
    this.reranker = options.reranker;
    this.fusionMode = options.fusion ?? "rrf";
    this.rrfK = options.rrfK ?? 60;
    this.weights = [options.weights?.bm25 ?? 1, options.weights?.vector ?? 1];
    this.candidateK = options.candidateK ?? 50;
    this.defaultLambda = options.mmrLambda ?? 1;
  }

  get size(): number {
    return this.texts.size;
  }

  ids(): string[] {
    return [...this.texts.keys()];
  }

  getText(id: string): string | undefined {
    return this.texts.get(id);
  }

  getVector(id: string): Float32Array | undefined {
    return this.vectors.get(id);
  }

  getMetadata(id: string): Metadata | undefined {
    return this.metadata.get(id);
  }

  /** Indexes documents lexically and (if an embedder is configured) vectorially. */
  async index(docs: IndexDoc[]): Promise<void> {
    for (const doc of docs) {
      this.bm25.add(doc.id, doc.text);
      this.texts.set(doc.id, doc.text);
      if (doc.metadata) this.metadata.set(doc.id, doc.metadata);
      if (doc.vector) this.vectors.set(doc.id, doc.vector);
    }

    const needVectors = this.embedder ? docs.filter((doc) => !doc.vector) : [];
    if (needVectors.length > 0 && this.embedder) {
      const vectors = await this.embedder.embed(needVectors.map((doc) => doc.text));
      needVectors.forEach((doc, i) => this.vectors.set(doc.id, vectors[i]));
    }
  }

  async add(doc: IndexDoc): Promise<void> {
    await this.index([doc]);
  }

  remove(id: string): boolean {
    this.texts.delete(id);
    this.vectors.delete(id);
    this.metadata.delete(id);
    return this.bm25.remove(id);
  }

  clear(): void {
    this.bm25.clear();
    this.texts.clear();
    this.vectors.clear();
    this.metadata.clear();
  }

  async embedQuery(query: string): Promise<Float32Array | undefined> {
    if (!this.embedder) return undefined;
    const [vector] = await this.embedder.embed([query]);
    return vector;
  }

  /** Brute-force cosine over locally indexed vectors. */
  vectorSearch(query: Float32Array, topK: number, filter?: (id: string) => boolean): Scored[] {
    const hits: Scored[] = [];
    for (const [id, vector] of this.vectors) {
      if (filter && !filter(id)) continue;
      if (vector.length !== query.length) continue;
      hits.push({ id, score: cosine(query, vector) });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits.slice(0, topK);
  }

  async search(query: string, options: SearchOptions = {}): Promise<RetrievalHit[]> {
    const topK = options.topK ?? 10;
    const candidateK = Math.max(options.candidateK ?? this.candidateK, topK);
    const filter = options.filter;

    const lexical = options.lexical ?? this.bm25.search(query, candidateK, filter);
    const vector = await this.resolveVectorCandidates(query, candidateK, options);

    const fused =
      this.fusionMode === "linear"
        ? linearFusion([lexical, vector], { weights: this.weights, normalize: "minmax" })
        : rrf([lexical, vector], this.rrfK, this.weights);

    const lexicalRank = rankMap(lexical);
    const vectorRank = rankMap(vector);
    const lexicalScore = scoreMap(lexical);
    const vectorScore = scoreMap(vector);

    let ordered = fused.slice(0, candidateK);
    const rerankScores = new Map<string, number>();

    if (this.reranker && options.rerank !== false && ordered.length > 0) {
      const getText = options.getText ?? ((id: string) => this.texts.get(id));
      const docs: TextDoc[] = [];
      for (const hit of ordered) {
        const text = getText(hit.id);
        if (text !== undefined) docs.push({ id: hit.id, text });
      }
      if (docs.length > 0) {
        const reranked = await this.reranker.rerank(query, docs, Math.min(docs.length, candidateK));
        for (const hit of reranked) rerankScores.set(hit.id, hit.score);
        // Reranked docs lead, in rerank order; anything without text keeps fused order after.
        const tail = ordered.filter((hit) => !rerankScores.has(hit.id));
        ordered = [...reranked, ...tail];
      }
    }

    const lambda = options.mmrLambda ?? this.defaultLambda;
    let diversified = false;
    if (lambda < 1 && ordered.length > 1) {
      const getVector = options.getVector ?? ((id: string) => this.vectors.get(id));
      ordered = mmr(ordered, getVector, lambda, Math.min(topK, ordered.length));
      diversified = true;
    }

    const fusedScore = scoreMap(fused);
    return ordered.slice(0, topK).map((hit) => {
      const components: RetrievalComponents = { fused: fusedScore.get(hit.id) };
      const reasons: string[] = [];

      if (lexicalRank.has(hit.id)) {
        components.bm25 = lexicalScore.get(hit.id);
        reasons.push(`bm25 #${lexicalRank.get(hit.id)}`);
      }
      if (vectorRank.has(hit.id)) {
        components.vector = vectorScore.get(hit.id);
        reasons.push(`vector #${vectorRank.get(hit.id)}`);
      }
      if (rerankScores.has(hit.id)) {
        components.rerank = rerankScores.get(hit.id);
        reasons.push("reranked");
      }
      if (diversified) reasons.push(`mmr λ=${lambda}`);

      return {
        id: hit.id,
        score: rerankScores.get(hit.id) ?? components.fused ?? hit.score,
        components,
        reasons,
        text: this.texts.get(hit.id),
        metadata: this.metadata.get(hit.id),
      };
    });
  }

  private async resolveVectorCandidates(
    query: string,
    candidateK: number,
    options: SearchOptions,
  ): Promise<Scored[]> {
    if (options.vectorCandidates) {
      return options.filter
        ? options.vectorCandidates.filter((hit) => options.filter?.(hit.id))
        : options.vectorCandidates;
    }

    const search = options.vectorSearch;
    if (!search && !this.embedder) return [];

    const queryVector = options.queryEmbedding ?? (await this.embedQuery(query));
    if (!queryVector) return [];

    if (!search) return this.vectorSearch(queryVector, candidateK, options.filter);
    const hits = await search(queryVector, candidateK);
    return options.filter ? hits.filter((hit) => options.filter?.(hit.id)) : hits;
  }
}

function rankMap(list: Scored[]): Map<string, number> {
  return new Map(list.map((hit, i) => [hit.id, i + 1]));
}

function scoreMap(list: Scored[]): Map<string, number> {
  return new Map(list.map((hit) => [hit.id, hit.score]));
}
