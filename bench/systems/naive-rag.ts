/**
 * Plain-RAG control: concatenate each session into a transcript, chunk with fixed
 * size + overlap, embed, cosine top-k. Nothing else — no recency prior, no memory
 * types, no importance, no supersession, no reranking.
 *
 * Chunking over session transcripts (rather than per-memory) is deliberate: it is what
 * a plain vector store over conversation logs actually does, and it reproduces the real
 * failure mode where one chunk carries a fact and its distractor at the same score.
 */
import { cosine, type EmbeddingProvider } from "../embedder.js";
import type { BenchSystem, MaterializedMemory, RankedHit } from "../types.js";

const CHUNK_CHARS = 400;
const OVERLAP_CHARS = 100;

interface Chunk {
  text: string;
  memoryIds: string[];
  vector: Float32Array;
}

export function createNaiveRagSystem(embedder: EmbeddingProvider): BenchSystem {
  let chunks: Chunk[] = [];

  return {
    name: "naive-rag",
    note: `chunk ${CHUNK_CHARS}/${OVERLAP_CHARS} over session transcripts, cosine top-k, embedder=${embedder.name}`,
    defaultMinScore: 0,

    async ingest(memories: MaterializedMemory[]) {
      // Group into session transcripts in chronological order.
      const bySession = new Map<string, MaterializedMemory[]>();
      for (const m of memories) {
        const list = bySession.get(m.sessionId) ?? [];
        list.push(m);
        bySession.set(m.sessionId, list);
      }

      const pending: Array<{ text: string; memoryIds: string[] }> = [];
      for (const [, mems] of [...bySession.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        mems.sort((a, b) => a.minuteOfDay - b.minuteOfDay || a.id.localeCompare(b.id));
        // Track each memory's char span inside the transcript so chunks map back to ids.
        let transcript = "";
        const spans: Array<{ id: string; start: number; end: number }> = [];
        for (const m of mems) {
          const start = transcript.length;
          transcript += `${m.text}\n`;
          spans.push({ id: m.id, start, end: transcript.length });
        }

        const step = CHUNK_CHARS - OVERLAP_CHARS;
        for (let start = 0; start < transcript.length; start += step) {
          const end = Math.min(transcript.length, start + CHUNK_CHARS);
          const covered = spans.filter((s) => s.start < end && s.end > start).map((s) => s.id);
          if (covered.length > 0) pending.push({ text: transcript.slice(start, end), memoryIds: covered });
          if (end >= transcript.length) break;
        }
      }

      const vectors = await embedder.embed(pending.map((p) => p.text));
      chunks = pending.map((p, i) => ({ ...p, vector: vectors[i]! }));
    },

    /**
     * Rank chunks by cosine, then expand each chunk into its member memories in
     * transcript order. This is what a plain RAG pipeline actually hands downstream;
     * pooling to per-memory scores instead would need an arbitrary tie-break inside a
     * chunk, which quietly biases ranks by id order.
     */
    async search(query: string, k: number): Promise<RankedHit[]> {
      const [qv] = await embedder.embed([query]);
      const scored = chunks
        .map((chunk, index) => ({ chunk, index, score: cosine(qv!, chunk.vector) }))
        .filter((c) => c.score > 0);
      scored.sort((a, b) => b.score - a.score || a.index - b.index);

      const hits: RankedHit[] = [];
      const seen = new Set<string>();
      for (const { chunk, score } of scored) {
        for (const id of chunk.memoryIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          hits.push({ id, score });
          if (hits.length >= k) return hits;
        }
      }
      return hits;
    },
  };
}
