import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HashEmbedder, cosine } from "./embedder.js";
import { HybridRetriever } from "./index.js";
import { NoopReranker, type Reranker } from "./rerank.js";
import type { Scored, TextDoc } from "./types.js";

const corpus = [
  { id: "m1", text: "The user is allergic to shellfish and avoids seafood restaurants." },
  { id: "m2", text: "The user has a shellfish allergy and stays away from seafood places." },
  { id: "m3", text: "The user prefers window seats on long haul flights." },
  { id: "m4", text: "The user works as a structural engineer in Rotterdam." },
  { id: "m5", text: "The mitochondrion is the powerhouse of the cell." },
];

const build = (options = {}) =>
  new HybridRetriever({ embedder: new HashEmbedder({ dims: 512 }), ...options });

describe("HybridRetriever", () => {
  test("finds the relevant memory and explains why", async () => {
    const retriever = build();
    await retriever.index(corpus.map((doc) => ({ ...doc, metadata: { source: "test" } })));

    const hits = await retriever.search("what food allergies does the user have?", { topK: 3 });
    assert.ok(hits.length > 0);
    assert.ok(["m1", "m2"].includes(hits[0].id), `unexpected top hit ${hits[0].id}`);
    assert.ok(hits[0].reasons.length > 0);
    assert.ok(hits[0].components.bm25 !== undefined || hits[0].components.vector !== undefined);
    assert.equal(hits[0].components.fused !== undefined, true);
    assert.deepEqual(hits[0].metadata, { source: "test" });
    assert.equal(hits[0].text, corpus.find((doc) => doc.id === hits[0].id)?.text);
    assert.ok(!hits.some((hit) => hit.id === "m5"));
  });

  test("reports both retrieval arms with ranks", async () => {
    const retriever = build();
    await retriever.index(corpus);
    const hits = await retriever.search("shellfish allergy", { topK: 5 });
    const top = hits[0];
    assert.ok(top.reasons.some((reason) => reason.startsWith("bm25 #")));
    assert.ok(top.reasons.some((reason) => reason.startsWith("vector #")));
    assert.ok((top.components.bm25 ?? 0) > 0);
    assert.ok((top.components.vector ?? 0) > 0);
  });

  test("works lexically with no embedder configured", async () => {
    const retriever = new HybridRetriever();
    await retriever.index(corpus);
    const hits = await retriever.search("allergies", { topK: 2 });
    assert.ok(hits.length > 0);
    assert.ok(["m1", "m2"].includes(hits[0].id));
    assert.equal(hits[0].components.vector, undefined);
  });

  test("accepts an external ANN callback instead of local vectors", async () => {
    const retriever = build();
    await retriever.index(corpus);

    let annCalls = 0;
    const vectors = new Map(corpus.map((doc) => [doc.id, retriever.getVector(doc.id)!]));
    const vectorSearch = async (query: Float32Array, topK: number): Promise<Scored[]> => {
      annCalls++;
      return [...vectors]
        .map(([id, vector]) => ({ id, score: cosine(query, vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    };

    const hits = await retriever.search("shellfish allergy", { topK: 3, vectorSearch });
    assert.equal(annCalls, 1);
    assert.ok(["m1", "m2"].includes(hits[0].id));
  });

  test("accepts injected candidate lists (storage-agnostic path)", async () => {
    const retriever = new HybridRetriever();
    const hits = await retriever.search("anything", {
      topK: 3,
      lexical: [
        { id: "x", score: 5 },
        { id: "y", score: 1 },
      ],
      vectorCandidates: [
        { id: "y", score: 0.9 },
        { id: "z", score: 0.4 },
      ],
      getText: (id) => `text for ${id}`,
    });
    assert.deepEqual(hits.map((hit) => hit.id), ["y", "x", "z"]);
    assert.equal(hits[0].components.bm25, 1);
    assert.equal(hits[0].components.vector, 0.9);
  });

  test("filter is applied to both arms", async () => {
    const retriever = build();
    await retriever.index(corpus);
    const hits = await retriever.search("shellfish allergy", {
      topK: 5,
      filter: (id) => id !== "m1",
    });
    assert.ok(!hits.some((hit) => hit.id === "m1"));
    assert.equal(hits[0].id, "m2");
  });

  test("mmr diversifies near-duplicate results", async () => {
    const retriever = build();
    await retriever.index([
      { id: "dup1", text: "The user is allergic to shellfish and avoids seafood." },
      { id: "dup2", text: "The user is allergic to shellfish and avoids seafood dishes." },
      { id: "dup3", text: "The user is allergic to shellfish and avoids seafood meals." },
      { id: "other", text: "The user is allergic to pollen during the shellfish season." },
    ]);

    const plain = await retriever.search("shellfish allergy", { topK: 2 });
    const diverse = await retriever.search("shellfish allergy", { topK: 2, mmrLambda: 0.3 });

    assert.ok(diverse.some((hit) => hit.id === "other"));
    assert.ok(!plain.some((hit) => hit.id === "other"));
    assert.ok(diverse[0].reasons.some((reason) => reason.startsWith("mmr")));
  });

  test("a reranker reorders results and is recorded in components", async () => {
    const retriever = build({
      reranker: {
        id: "test",
        // Prefer whatever mentions engineering, regardless of fusion order.
        rerank: async (_query: string, docs: TextDoc[], topK: number) =>
          docs
            .map((doc) => ({ id: doc.id, score: doc.text.includes("engineer") ? 1 : 0.1 }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK),
      } satisfies Reranker,
    });
    await retriever.index(corpus);

    const hits = await retriever.search("shellfish allergy", { topK: 2 });
    assert.equal(hits[0].id, "m4");
    assert.equal(hits[0].components.rerank, 1);
    assert.ok(hits[0].reasons.includes("reranked"));

    const skipped = await retriever.search("shellfish allergy", { topK: 2, rerank: false });
    assert.ok(["m1", "m2"].includes(skipped[0].id));
    assert.equal(skipped[0].components.rerank, undefined);
  });

  test("NoopReranker preserves fused order", async () => {
    const retriever = build({ reranker: new NoopReranker() });
    await retriever.index(corpus);
    const withNoop = await retriever.search("shellfish allergy", { topK: 3 });
    const withoutNoop = await retriever.search("shellfish allergy", { topK: 3, rerank: false });
    assert.deepEqual(
      withNoop.map((hit) => hit.id),
      withoutNoop.map((hit) => hit.id),
    );
  });

  test("linear fusion is selectable", async () => {
    const retriever = build({ fusion: "linear" as const });
    await retriever.index(corpus);
    const hits = await retriever.search("shellfish allergy", { topK: 2 });
    assert.ok(["m1", "m2"].includes(hits[0].id));
    assert.ok((hits[0].components.fused ?? 0) > 1);
  });

  test("remove drops a document from every store", async () => {
    const retriever = build();
    await retriever.index(corpus);
    assert.equal(retriever.size, 5);
    assert.equal(retriever.remove("m1"), true);
    assert.equal(retriever.size, 4);
    assert.equal(retriever.getVector("m1"), undefined);
    assert.equal(retriever.getText("m1"), undefined);
    assert.equal(retriever.bm25.has("m1"), false);

    const hits = await retriever.search("shellfish allergy", { topK: 5 });
    assert.ok(!hits.some((hit) => hit.id === "m1"));
    retriever.clear();
    assert.equal(retriever.size, 0);
    assert.deepEqual(await retriever.search("shellfish"), []);
  });

  test("precomputed vectors bypass the embedder", async () => {
    const embedder = new HashEmbedder({ dims: 512 });
    const retriever = new HybridRetriever({ embedder });
    const vector = embedder.embedOne("shellfish allergy");
    await retriever.add({ id: "p1", text: "totally different words here", vector });
    assert.deepEqual([...retriever.getVector("p1")!], [...vector]);
    const hits = await retriever.search("shellfish allergy", { topK: 1 });
    assert.equal(hits[0].id, "p1");
  });
});
