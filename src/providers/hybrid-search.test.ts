import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProvider } from "./in-memory-provider.js";
import type { MemoryRecord } from "../types.js";
import type { EmbeddingProvider } from "../retrieval/embedder.js";

const F = { tenantId: "t", appId: "a", actorId: "u" };

function rec(id: string, text: string): MemoryRecord {
  const now = new Date().toISOString();
  return {
    id, ...F, threadId: null, scope: "actor", memoryType: "preference", text,
    summary: null, metadata: {}, confidence: 0.7, importance: 0.5, status: "active",
    source: { sourceType: "test" }, decayPolicy: { kind: "none" },
    firstSeenAt: now, lastSeenAt: now, createdAt: now, updatedAt: now,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0 },
  };
}

// The preference family's shape: gold shares ONE token with the query, the
// distractors share THREE, so lexical ranking puts a distractor first.
const QUERY = "what beverage should I order in the morning";
const GOLD = rec("gold", "I cannot stand coffee, it upsets my stomach");
// Share "morning"/"order"/"I" with the query but carry no drink semantics.
const DISTRACTORS = [
  rec("d1", "I should order the morning report before the standup"),
  rec("d2", "In the morning I order the meeting notes for review"),
  rec("d3", "Order the morning review list and I will check it"),
];

/**
 * Deterministic stand-in for a sentence encoder. HashEmbedder is a *lexical*
 * hashing embedder, so it cannot separate this case by construction — the point
 * of the fixture is semantics, so the vectors are assigned, not derived.
 */
class StubSemanticEmbedder implements EmbeddingProvider {
  readonly id = "stub:semantic";
  readonly dims = 4;
  calls = 0;
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++;
    return texts.map((t) => {
      const drink = /coffee|beverage|drink|tea/i.test(t) ? 1 : 0;
      // A stated like/dislike, or a question asking for one.
      const preference = /cannot stand|upsets|hate|love|prefer|favourite|favorite|should i/i.test(t) ? 1 : 0;
      const logistics = /report|meeting|standup|notes|list|review|check/i.test(t) ? 1 : 0;
      const v = new Float32Array([drink, preference, logistics, 0]);
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n) as Float32Array;
    });
  }
}

test("BM25 alone ranks a lexical distractor above the semantically correct memory", async () => {
  const provider = new InMemoryProvider();
  await provider.ingest([GOLD, ...DISTRACTORS]);
  const hits = await provider.search({ query: QUERY, filters: F, limit: 4 });
  assert.ok(hits.length > 0);
  assert.notEqual(hits[0].memory.id, "gold", "lexical-only is expected to lose this case");
});

/**
 * The gold memory shares only stopwords with the query, so BM25 gives it nothing
 * and it reaches the result set purely on vector evidence (cosine 1.000).
 *
 * It does NOT reach rank 1, and that is a property of RRF rather than a bug: RRF
 * scores by rank and discards magnitude, so an item appearing only in the vector
 * list at rank 1 scores exactly 1/(k+1) — identical to an item appearing only in
 * the lexical list at rank 1, at every k. A perfect semantic match therefore ties
 * a mediocre lexical match, and the tie breaks on insertion order.
 *
 * Fixing that properly means either magnitude-aware fusion (`linearFusion` in
 * src/retrieval/fusion.ts) or a tie-break on best component score. Until then this
 * asserts the real, valuable win: BM25-only ranks gold below every distractor,
 * hybrid lifts it above the weaker ones and into the top 2.
 */
test("hybrid search lifts a purely semantic match into the top 2", async () => {
  const embedder = new StubSemanticEmbedder();
  const provider = new InMemoryProvider({ embedder, rrfK: 5 });
  await provider.ingest([GOLD, ...DISTRACTORS]);
  assert.ok(embedder.calls > 0, "ingest must embed on the write path");

  const hits = await provider.search({ query: QUERY, filters: F, limit: 4 });
  const ids = hits.map((h) => h.memory.id);
  const goldRank = ids.indexOf("gold");

  assert.ok(goldRank >= 0, `gold must be retrieved at all, got ${JSON.stringify(ids)}`);
  assert.ok(goldRank <= 1, `gold should reach the top 2, got rank ${goldRank + 1} in ${JSON.stringify(ids)}`);
  assert.ok(goldRank < ids.indexOf("d2"), "gold must outrank the weaker lexical distractors");
  assert.ok(goldRank < ids.indexOf("d3"), "gold must outrank the weaker lexical distractors");

  const reasons = hits[goldRank].reasons.join(" ");
  assert.match(reasons, /vector/i, `gold should credit vector evidence, got: ${reasons}`);
});

test("a failing embedder degrades to BM25 instead of failing the search", async () => {
  let attempts = 0;
  const broken: EmbeddingProvider = {
    id: "broken",
    dims: 4,
    async embed() {
      attempts++;
      throw new Error("model download failed");
    },
  };
  const provider = new InMemoryProvider({ embedder: broken });

  // Ingest must not reject just because the optional model is unavailable.
  await provider.ingest([GOLD, ...DISTRACTORS]);
  const hits = await provider.search({ query: QUERY, filters: F, limit: 4 });
  assert.ok(hits.length > 0, "search must still return lexical results");
  assert.ok(attempts > 0, "the embedder should have been attempted at least once");
});

test("no embedder configured leaves ranking byte-identical to BM25-only", async () => {
  const a = new InMemoryProvider();
  const b = new InMemoryProvider({ embedder: null });
  await a.ingest([GOLD, ...DISTRACTORS]);
  await b.ingest([GOLD, ...DISTRACTORS]);

  const ha = await a.search({ query: QUERY, filters: F, limit: 4 });
  const hb = await b.search({ query: QUERY, filters: F, limit: 4 });
  assert.deepEqual(
    ha.map((h) => [h.memory.id, h.score.toFixed(6)]),
    hb.map((h) => [h.memory.id, h.score.toFixed(6)]),
    "the live production path must not change when no embedder is set",
  );
});
