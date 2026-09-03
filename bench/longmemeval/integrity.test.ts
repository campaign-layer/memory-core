import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateExitCode, datasetShaFromManifest, parseNonNegativeInteger,
  modeBRowMatchesRun, parseSubsetQuestionIds, parseSystemNames, rowMatchesRun, selectQuestionIds,
  systemRunFailures, type ModeARunIdentity,
} from "./integrity.js";

const RUN: ModeARunIdentity = {
  repoSha: "sha-current",
  repoRoot: "/repo/current",
  datasetSha: "dataset-current",
  seed: 1234,
};

const stampedRow = (overrides: Record<string, unknown> = {}) => ({
  qid: "q1",
  repoSha: RUN.repoSha,
  repoRoot: RUN.repoRoot,
  datasetSha: RUN.datasetSha,
  seed: RUN.seed,
  ...overrides,
});

test("error rows make aggregation fail even when row count is complete", () => {
  const failures = systemRunFailures(
    "bm25",
    [stampedRow({ error: "provider failed" })],
    ["q1"],
    RUN,
  );

  assert.deepEqual(failures, ["bm25: 1 current-run row(s) contain errors"]);
  assert.equal(aggregateExitCode(failures), 1);
  assert.equal(aggregateExitCode(systemRunFailures("bm25", [stampedRow()], ["q1"], RUN)), 0);
});

test("deduplicated rows cannot hide a missing question", () => {
  const failures = systemRunFailures(
    "bm25",
    [stampedRow()],
    ["q1", "q2"],
    RUN,
  );

  assert.match(failures.join("\n"), /missing 1 expected question/);
  assert.equal(aggregateExitCode(failures), 1);
});

test("limit selection is lexical and independent of manifest insertion order", () => {
  assert.deepEqual(selectQuestionIds(["z", "a", "m"], null, 2), ["a", "m"]);
  assert.deepEqual(selectQuestionIds(["m", "z", "a"], null, 2), ["a", "m"]);
  assert.deepEqual(selectQuestionIds(["z", "a", "m"], ["z", "a"], 1), ["a"]);
});

test("cache identity invalidates rows from a different dataset or seed", () => {
  assert.equal(rowMatchesRun(stampedRow(), RUN), true);
  assert.equal(rowMatchesRun(stampedRow({ datasetSha: "dataset-old" }), RUN), false);
  assert.equal(rowMatchesRun(stampedRow({ seed: 999 }), RUN), false);
  assert.equal(rowMatchesRun({ repoSha: RUN.repoSha, repoRoot: RUN.repoRoot }, RUN), false);
  assert.equal(datasetShaFromManifest({ provenance: { dataset: { sha256: "dataset-current" } } }), "dataset-current");
  assert.throws(() => datasetShaFromManifest({}), /no dataset sha256/);
});

test("cache identity rejects stale SHA and root", () => {
  assert.equal(rowMatchesRun(stampedRow({ repoSha: "sha-old" }), RUN), false);
  assert.equal(rowMatchesRun(stampedRow({ repoRoot: "/repo/other" }), RUN), false);
  assert.equal(rowMatchesRun(stampedRow(), RUN), true);
});

test("Mode B cache identity includes retrieval system, model, and condition", () => {
  const expected = {
    ...RUN,
    retrievalSystem: "memory-core",
    model: "deepseek/deepseek-v4-flash",
    condition: "k30",
  };
  const row = { ...stampedRow(), ...expected };
  assert.equal(modeBRowMatchesRun(row, expected), true);
  assert.equal(modeBRowMatchesRun({ ...row, retrievalSystem: "bm25" }, expected), false);
  assert.equal(modeBRowMatchesRun({ ...row, model: "other-model" }, expected), false);
  assert.equal(modeBRowMatchesRun({ ...row, condition: "k10" }, expected), false);
});

test("invalid, empty, duplicate, and unknown subsets fail closed", () => {
  assert.throws(() => parseSubsetQuestionIds({}), /JSON array/);
  assert.throws(() => parseSubsetQuestionIds([]), /at least one/);
  assert.throws(() => parseSubsetQuestionIds(["q1", "q1"]), /duplicate/);
  assert.throws(() => parseSubsetQuestionIds(["q1", ""]), /non-empty strings/);
  assert.throws(() => selectQuestionIds(["q1"], ["q1", "missing"], 0), /unknown question/);
  assert.throws(() => selectQuestionIds([], null, 0), /selection is empty/);
});

test("empty systems and invalid numeric controls fail closed", () => {
  assert.throws(() => parseSystemNames(""), /at least one/);
  assert.throws(() => parseSystemNames(" , "), /at least one/);
  assert.throws(() => parseSystemNames("bm25,bm25"), /duplicates/);
  assert.deepEqual(parseSystemNames("bm25, memory-core"), ["bm25", "memory-core"]);
  assert.throws(() => parseNonNegativeInteger("NaN", "limit"), /non-negative integer/);
  assert.throws(() => parseNonNegativeInteger("-1", "limit"), /non-negative integer/);
  assert.equal(parseNonNegativeInteger("0", "limit"), 0);
});
