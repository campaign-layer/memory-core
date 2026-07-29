// Okapi BM25 over memory texts. Lexical-only reference point: no recency, no
// importance, no type priors, no embeddings.
import { tokenize } from "../tokenize.js";
import type { BenchSystem, MaterializedMemory, RankedHit } from "../types.js";

const K1 = 1.5;
const B = 0.75;

export function createBm25System(): BenchSystem {
  let docs: Array<{ id: string; tf: Map<string, number>; len: number }> = [];
  let df = new Map<string, number>();
  let avgLen = 0;

  return {
    name: "bm25",
    note: `Okapi BM25 (k1=${K1}, b=${B}), bench-local tokenizer`,
    defaultMinScore: 0, // BM25 scores are unbounded; no principled gate exists.

    async ingest(memories: MaterializedMemory[]) {
      docs = [];
      df = new Map();
      for (const m of memories) {
        const tokens = tokenize(m.text);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
        docs.push({ id: m.id, tf, len: tokens.length });
      }
      avgLen = docs.length ? docs.reduce((a, d) => a + d.len, 0) / docs.length : 0;
    },

    async search(query: string, k: number): Promise<RankedHit[]> {
      const qTokens = tokenize(query);
      const n = docs.length;
      const hits: RankedHit[] = [];
      for (const doc of docs) {
        let score = 0;
        for (const t of qTokens) {
          const f = doc.tf.get(t);
          if (!f) continue;
          const dfT = df.get(t) ?? 0;
          const idf = Math.log(1 + (n - dfT + 0.5) / (dfT + 0.5));
          score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.len / (avgLen || 1)))));
        }
        if (score > 0) hits.push({ id: doc.id, score });
      }
      hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return hits.slice(0, k);
    },
  };
}
