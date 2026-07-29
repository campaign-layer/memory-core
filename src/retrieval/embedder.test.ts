import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CachedEmbedder,
  HashEmbedder,
  LocalOnnxEmbedder,
  OpenAIEmbedder,
  VoyageEmbedder,
  cosine,
  l2Normalize,
} from "./embedder.js";

const norm = (v: Float32Array) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));

describe("cosine", () => {
  test("does not clamp negative similarity", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([-1, 0]);
    assert.equal(cosine(a, b), -1);
    assert.equal(cosine(a, Float32Array.from([0, 1])), 0);
    assert.equal(cosine(a, a), 1);
  });

  test("handles unnormalized vectors and zero vectors", () => {
    assert.ok(Math.abs(cosine(Float32Array.from([3, 4]), Float32Array.from([6, 8])) - 1) < 1e-6);
    assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0);
  });

  test("rejects dimension mismatch", () => {
    assert.throws(() => cosine(new Float32Array(2), new Float32Array(3)), /dim mismatch/);
  });
});

describe("l2Normalize", () => {
  test("produces unit vectors and leaves zeros alone", () => {
    assert.ok(Math.abs(norm(l2Normalize(Float32Array.from([3, 4]))) - 1) < 1e-6);
    assert.equal(norm(l2Normalize(new Float32Array(4))), 0);
  });
});

describe("HashEmbedder", () => {
  const embedder = new HashEmbedder({ dims: 512 });

  test("is deterministic, unit norm, and correctly sized", () => {
    const a = embedder.embedOne("the user is allergic to shellfish");
    const b = embedder.embedOne("the user is allergic to shellfish");
    assert.equal(a.length, 512);
    assert.deepEqual([...a], [...b]);
    assert.ok(Math.abs(norm(a) - 1) < 1e-5);
    assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
    assert.equal(embedder.dims, 512);
    assert.equal(embedder.id, "hash-bow-512");
  });

  test("AUDIT FIX: paraphrases beat an unrelated biology sentence", async () => {
    // The old MockEmbeddingService scored these paraphrases 0.0000 and the
    // unrelated sentence 0.9986. Signed feature hashing gets the order right.
    const paraphraseA = "The user is allergic to shellfish and avoids seafood restaurants.";
    const paraphraseB = "The user has a shellfish allergy and stays away from seafood places.";
    const unrelated = "The mitochondrion is the powerhouse of the cell.";

    const [a, b, c] = await embedder.embed([paraphraseA, paraphraseB, unrelated]);
    const paraphraseSim = cosine(a, b);
    const unrelatedSim = cosine(a, c);

    assert.ok(paraphraseSim > unrelatedSim, `${paraphraseSim} should exceed ${unrelatedSim}`);
    assert.ok(paraphraseSim > 0.3, `paraphrases should be clearly similar, got ${paraphraseSim}`);
    assert.ok(Math.abs(unrelatedSim) < 0.15, `unrelated should be near zero, got ${unrelatedSim}`);
  });

  test("similarity is monotone in token overlap", () => {
    const base = embedder.embedOne("the user is allergic to shellfish and avoids seafood");
    const high = embedder.embedOne("user allergic shellfish avoids seafood restaurants");
    const some = embedder.embedOne("the user avoids seafood");
    const none = embedder.embedOne("quarterly revenue exceeded projections in Berlin");

    assert.ok(cosine(base, high) > cosine(base, some));
    assert.ok(cosine(base, some) > cosine(base, none));
    assert.ok(cosine(base, none) < 0.15);
  });

  test("matches morphological variants through the shared stemmer", () => {
    const stored = embedder.embedOne("I am allergic to shellfish");
    const query = embedder.embedOne("shellfish allergies");
    assert.ok(cosine(stored, query) > 0.5);
  });

  test("empty and stopword-only text yields a zero vector, not a bogus match", () => {
    const empty = embedder.embedOne("");
    const stopwords = embedder.embedOne("the and of it is");
    assert.equal(norm(empty), 0);
    assert.equal(norm(stopwords), 0);
    assert.equal(cosine(empty, embedder.embedOne("shellfish")), 0);
  });

  test("batch embed preserves input order", async () => {
    const texts = ["alpha beta", "gamma delta", "epsilon zeta"];
    const vectors = await embedder.embed(texts);
    assert.equal(vectors.length, 3);
    vectors.forEach((vector, i) => {
      assert.ok(Math.abs(cosine(vector, embedder.embedOne(texts[i])) - 1) < 1e-6);
    });
  });
});

describe("CachedEmbedder", () => {
  test("calls the inner provider once per distinct text", async () => {
    let calls = 0;
    const inner = new HashEmbedder({ dims: 64 });
    const counting = {
      id: inner.id,
      dims: inner.dims,
      embed: async (texts: string[]) => {
        calls += texts.length;
        return inner.embed(texts);
      },
    };
    const cached = new CachedEmbedder(counting);

    const first = await cached.embed(["alpha", "beta", "alpha"]);
    const second = await cached.embed(["alpha", "beta"]);
    assert.equal(calls, 2);
    assert.equal(first.length, 3);
    assert.deepEqual([...first[0]], [...first[2]]);
    assert.deepEqual([...second[0]], [...first[0]]);
    assert.equal(cached.dims, 64);
  });
});

describe("hosted providers", () => {
  test("throw a clear error when no key is configured", async () => {
    await assert.rejects(
      () => new VoyageEmbedder({ apiKey: undefined }).embed(["hi"]),
      /VOYAGE_API_KEY/,
    );
    await assert.rejects(
      () => new OpenAIEmbedder({ apiKey: undefined }).embed(["hi"]),
      /OPENAI_API_KEY/,
    );
  });

  test("empty input short-circuits before any key check", async () => {
    assert.deepEqual(await new VoyageEmbedder({ apiKey: undefined }).embed([]), []);
    assert.deepEqual(await new OpenAIEmbedder({ apiKey: undefined }).embed([]), []);
  });

  test("advertise their model ids and dims", () => {
    assert.equal(new VoyageEmbedder().id, "voyage:voyage-3");
    assert.equal(new VoyageEmbedder().dims, 1024);
    assert.equal(new OpenAIEmbedder().id, "openai:text-embedding-3-large");
    assert.equal(new OpenAIEmbedder().dims, 3072);
  });
});

describe("LocalOnnxEmbedder", () => {
  test("construction is cheap and does not load the model", () => {
    const embedder = new LocalOnnxEmbedder();
    assert.equal(embedder.dims, 384);
    assert.equal(embedder.id, "onnx:Xenova/bge-small-en-v1.5");
  });

  test("empty input needs no model", async () => {
    assert.deepEqual(await new LocalOnnxEmbedder().embed([]), []);
  });

  // Opt-in: downloads ~35MB on first run. RETRIEVAL_ONNX_TEST=1 npx tsx --test ...
  test(
    "real semantic ordering on the audit case",
    { skip: process.env.RETRIEVAL_ONNX_TEST !== "1" },
    async () => {
      const embedder = new LocalOnnxEmbedder();
      const [a, b, c] = await embedder.embed([
        "The user is allergic to shellfish and avoids seafood restaurants.",
        "The user has a shellfish allergy and stays away from seafood places.",
        "The mitochondrion is the powerhouse of the cell.",
      ]);
      assert.equal(a.length, 384);
      assert.ok(Math.abs(norm(a) - 1) < 1e-4);
      assert.ok(cosine(a, b) > cosine(a, c));
      assert.ok(cosine(a, b) > 0.8);
    },
  );
});
