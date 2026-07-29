// Shared shapes for the retrieval core. Storage-agnostic on purpose: nothing
// here knows about Postgres, files, or the memory record schema.

export interface Scored {
  id: string;
  score: number;
}

export interface TextDoc {
  id: string;
  text: string;
}

export type Tokenizer = (text: string) => string[];

/** Vector search callback so retrieval never owns the ANN index. */
export type VectorSearchFn = (query: Float32Array, topK: number) => Promise<Scored[]>;
