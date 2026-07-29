import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { linearFusion, minMax, rrf, zScore } from "./fusion.js";

const listA = [
  { id: "a", score: 10 },
  { id: "b", score: 5 },
  { id: "c", score: 1 },
];
const listB = [
  { id: "c", score: 9 },
  { id: "a", score: 8 },
  { id: "d", score: 2 },
];

const close = (actual: number, expected: number, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `${actual} !~= ${expected}`);

describe("rrf", () => {
  test("matches the hand-computed fixture", () => {
    const fused = rrf([listA, listB], 60);
    assert.deepEqual(fused.map((hit) => hit.id), ["a", "c", "b", "d"]);
    close(fused[0].score, 1 / 61 + 1 / 62);
    close(fused[1].score, 1 / 63 + 1 / 61);
    close(fused[2].score, 1 / 62);
    close(fused[3].score, 1 / 63);
  });

  test("ignores score magnitude, only rank", () => {
    const inflated = listB.map((hit) => ({ ...hit, score: hit.score * 1000 }));
    assert.deepEqual(rrf([listA, inflated], 60), rrf([listA, listB], 60));
  });

  test("weights shift the fused order", () => {
    const fused = rrf([listA, listB], 60, [1, 3]);
    assert.deepEqual(fused.map((hit) => hit.id), ["c", "a", "d", "b"]);
    close(fused[2].score, 3 / 63);
  });

  test("a zero weight removes a list entirely", () => {
    const fused = rrf([listA, listB], 60, [1, 0]);
    assert.deepEqual(fused.map((hit) => hit.id), ["a", "b", "c"]);
  });

  test("smaller k sharpens the top of the ranking", () => {
    const sharp = rrf([listA, listB], 1);
    close(sharp[0].score, 1 / 2 + 1 / 3);
    assert.equal(sharp[0].id, "a");
  });

  test("unsorted input is sorted defensively", () => {
    const shuffled = [listA[2], listA[0], listA[1]];
    assert.deepEqual(rrf([shuffled]), rrf([listA]));
  });

  test("handles empty input", () => {
    assert.deepEqual(rrf([]), []);
    assert.deepEqual(rrf([[], []]), []);
  });
});

describe("normalizers", () => {
  test("minMax rescales to [0,1]", () => {
    const scaled = minMax(listA);
    close(scaled[0].score, 1);
    close(scaled[1].score, (5 - 1) / 9);
    close(scaled[2].score, 0);
  });

  test("minMax collapses a constant list to 1", () => {
    const scaled = minMax([{ id: "a", score: 4 }, { id: "b", score: 4 }]);
    assert.deepEqual(scaled.map((hit) => hit.score), [1, 1]);
  });

  test("zScore is mean-zero and preserves order", () => {
    const scaled = zScore(listA);
    close(scaled.reduce((sum, hit) => sum + hit.score, 0), 0);
    assert.ok(scaled[0].score > scaled[1].score && scaled[1].score > scaled[2].score);
    assert.deepEqual(
      zScore([{ id: "a", score: 2 }, { id: "b", score: 2 }]).map((hit) => hit.score),
      [0, 0],
    );
  });
});

describe("linearFusion", () => {
  test("keeps score magnitude, unlike rrf", () => {
    const fused = linearFusion([listA, listB], { normalize: "minmax" });
    // a: 1 + (8-2)/7 ; c: 0 + 1 ; b: 4/9 + 0 ; d: 0 + 0
    close(fused[0].score, 1 + 6 / 7);
    assert.equal(fused[0].id, "a");
    assert.deepEqual(fused.map((hit) => hit.id), ["a", "c", "b", "d"]);
  });

  test("weights apply per list", () => {
    const fused = linearFusion([listA, listB], { normalize: "minmax", weights: [0, 1] });
    assert.equal(fused[0].id, "c");
    close(fused[0].score, 1);
  });

  test("missing default penalizes single-list hits", () => {
    const fused = linearFusion([listA, listB], { normalize: "minmax", missing: -1 });
    const byId = new Map(fused.map((hit) => [hit.id, hit.score]));
    close(byId.get("b") ?? 0, 4 / 9 - 1);
    close(byId.get("d") ?? 0, -1);
  });

  test("normalize none passes raw scores through", () => {
    const fused = linearFusion([listA, listB], { normalize: "none" });
    const byId = new Map(fused.map((hit) => [hit.id, hit.score]));
    close(byId.get("a") ?? 0, 18);
  });
});
