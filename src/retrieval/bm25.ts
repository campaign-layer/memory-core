import { tokenize } from "./tokenize.js";
import type { Scored, TextDoc, Tokenizer } from "./types.js";

export interface Bm25Options {
  /** Term-frequency saturation. */
  k1?: number;
  /** Document-length normalization strength (0 = off, 1 = full). */
  b?: number;
  tokenizer?: Tokenizer;
}

export interface Bm25Stats {
  documents: number;
  terms: number;
  averageDocLength: number;
}

/**
 * Okapi BM25 with an inverted index. Supports incremental add/remove; document
 * frequency comes from posting-list size so removal can never leave stale df,
 * and avgdl is recomputed from a running total length.
 */
export class BM25Index {
  readonly k1: number;
  readonly b: number;
  private readonly tokenizer: Tokenizer;

  private readonly postings = new Map<string, Map<string, number>>();
  private readonly docs = new Map<string, { length: number; terms: Set<string> }>();
  private totalLength = 0;

  constructor(options: Bm25Options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.tokenizer = options.tokenizer ?? tokenize;

    // Outside these ranges the length-normalization term can go <= 0 for short
    // documents, producing negative or infinite scores instead of a rejection.
    if (!Number.isFinite(this.k1) || this.k1 < 0) {
      throw new RangeError(`BM25 k1 must be a finite number >= 0, got ${options.k1}`);
    }
    if (!Number.isFinite(this.b) || this.b < 0 || this.b > 1) {
      throw new RangeError(`BM25 b must be a finite number in [0, 1], got ${options.b}`);
    }
  }

  get size(): number {
    return this.docs.size;
  }

  /** Average document length in tokens; 0 for an empty index. */
  get averageDocLength(): number {
    return this.docs.size === 0 ? 0 : this.totalLength / this.docs.size;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  stats(): Bm25Stats {
    return {
      documents: this.docs.size,
      terms: this.postings.size,
      averageDocLength: this.averageDocLength,
    };
  }

  /** Adds or replaces a document. */
  add(id: string, text: string): void {
    if (this.docs.has(id)) this.remove(id);

    const tokens = this.tokenizer(text);
    const terms = new Set<string>();
    for (const token of tokens) {
      let posting = this.postings.get(token);
      if (!posting) {
        posting = new Map<string, number>();
        this.postings.set(token, posting);
      }
      posting.set(id, (posting.get(id) ?? 0) + 1);
      terms.add(token);
    }

    this.docs.set(id, { length: tokens.length, terms });
    this.totalLength += tokens.length;
  }

  addMany(docs: TextDoc[]): void {
    for (const doc of docs) this.add(doc.id, doc.text);
  }

  /** Removes a document, decrementing df and avgdl. Returns false if unknown. */
  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;

    for (const term of doc.terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      posting.delete(id);
      if (posting.size === 0) this.postings.delete(term);
    }

    this.totalLength -= doc.length;
    this.docs.delete(id);
    if (this.docs.size === 0) this.totalLength = 0;
    return true;
  }

  clear(): void {
    this.postings.clear();
    this.docs.clear();
    this.totalLength = 0;
  }

  /** Number of documents containing the (already stemmed) term. */
  documentFrequency(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  /** Robertson-Sparck-Jones IDF: ln(1 + (N - df + 0.5) / (df + 0.5)). */
  idf(term: string): number {
    const df = this.documentFrequency(term);
    const n = this.docs.size;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** BM25 score of one document against a raw query string. */
  scoreDocument(query: string, id: string): number {
    const doc = this.docs.get(id);
    if (!doc) return 0;
    let score = 0;
    for (const term of new Set(this.tokenizer(query))) {
      const tf = this.postings.get(term)?.get(id) ?? 0;
      if (tf === 0) continue;
      score += this.idf(term) * this.termWeight(tf, doc.length);
    }
    return score;
  }

  search(query: string, topK = 10, filter?: (id: string) => boolean): Scored[] {
    // A caller asking for 0 results wants none, not everything.
    if (topK <= 0) return [];
    const terms = new Set(this.tokenizer(query));
    if (terms.size === 0 || this.docs.size === 0) return [];

    const avgdl = this.averageDocLength || 1;
    const acc = new Map<string, number>();

    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = this.idf(term);
      for (const [id, tf] of posting) {
        if (filter && !filter(id)) continue;
        const length = this.docs.get(id)?.length ?? 0;
        const norm = tf + this.k1 * (1 - this.b + (this.b * length) / avgdl);
        acc.set(id, (acc.get(id) ?? 0) + (idf * (tf * (this.k1 + 1))) / norm);
      }
    }

    const hits: Scored[] = [];
    for (const [id, score] of acc) {
      if (score > 0) hits.push({ id, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return topK > 0 ? hits.slice(0, topK) : hits;
  }

  private termWeight(tf: number, docLength: number): number {
    const avgdl = this.averageDocLength || 1;
    const norm = tf + this.k1 * (1 - this.b + (this.b * docLength) / avgdl);
    return (tf * (this.k1 + 1)) / norm;
  }
}
