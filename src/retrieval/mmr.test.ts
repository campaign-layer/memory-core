import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { l2Normalize } from "./embedder.js";
import { mmr } from "./mmr.js";

const vector = (...values: number[]) => l2Normalize(Float32Array.from(values));

// d1/d2/d3 are near duplicates; d4 points elsewhere.
const embeddings = new Map([
  ["d1", vector(1, 0, 0)],
  ["d2", vector(0.99, 0.14, 0)],
  ["d3", vector(0.98, 0.2, 0)],
  ["d4", vector(0, 1, 0)],
]);

const candidates = [
  { id: "d1", score: 1.0 },
  { id: "d2", score: 0.9 },
  { id: "d3", score: 0.85 },
  { id: "d4", score: 0.6 },
];

describe("mmr", () => {
  test("lambda = 1 is pure relevance order", () => {
    const selected = mmr(candidates, embeddings, 1, 3);
    assert.deepEqual(selected.map((hit) => hit.id), ["d1", "d2", "d3"]);
  });

  test("lambda < 1 promotes a diverse candidate over near duplicates", () => {
    const selected = mmr(candidates, embeddings, 0.5, 3);
    assert.deepEqual(selected.map((hit) => hit.id), ["d1", "d4", "d2"]);
  });

  test("lambda = 0 is pure diversity and still starts from the top hit", () => {
    const selected = mmr(candidates, embeddings, 0, 2);
    assert.equal(selected[0].id, "d1");
    assert.equal(selected[1].id, "d4");
  });

  test("selected hits keep their original relevance scores", () => {
    const selected = mmr(candidates, embeddings, 0.5, 4);
    const byId = new Map(selected.map((hit) => [hit.id, hit.score]));
    assert.equal(byId.get("d4"), 0.6);
    assert.equal(byId.get("d1"), 1.0);
    assert.equal(selected.length, 4);
  });

  test("k truncates and never repeats a candidate", () => {
    const selected = mmr(candidates, embeddings, 0.5, 2);
    assert.equal(selected.length, 2);
    assert.equal(new Set(selected.map((hit) => hit.id)).size, 2);
  });

  test("candidates without vectors take no diversity penalty", () => {
    const selected = mmr(candidates, new Map(), 0.5, 4);
    assert.deepEqual(selected.map((hit) => hit.id), ["d1", "d2", "d3", "d4"]);
  });

  test("accepts a lookup function", () => {
    const selected = mmr(candidates, (id) => embeddings.get(id), 0.5, 2);
    assert.deepEqual(selected.map((hit) => hit.id), ["d1", "d4"]);
  });

  test("degenerate inputs are safe", () => {
    assert.deepEqual(mmr([], embeddings, 0.5, 3), []);
    assert.deepEqual(mmr(candidates, embeddings, 0.5, 0), []);
    assert.equal(mmr([candidates[0]], embeddings, 0.5, 5).length, 1);
  });
});
