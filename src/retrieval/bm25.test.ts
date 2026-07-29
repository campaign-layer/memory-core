import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BM25Index } from "./bm25.js";
import { stem, tokenize } from "./tokenize.js";

const idf = (n: number, df: number) => Math.log(1 + (n - df + 0.5) / (df + 0.5));

describe("tokenize + stem", () => {
  test("allergies and allergic share a stem (audit regression)", () => {
    assert.equal(stem("allergies"), stem("allergic"));
    assert.equal(stem("allergy"), stem("allergic"));
    assert.deepEqual(tokenize("allergies"), tokenize("allergic"));
  });

  test("common morphology collapses", () => {
    assert.equal(stem("running"), stem("run"));
    assert.equal(stem("moved"), stem("moving"));
    assert.equal(stem("cities"), stem("city"));
    assert.equal(stem("boxes"), stem("box"));
    assert.equal(stem("happiness"), stem("happy"));
    assert.equal(stem("quickly"), stem("quick"));
  });

  test("drops stopwords and single chars, keeps digits intact", () => {
    assert.deepEqual(tokenize("I am a X"), []);
    assert.deepEqual(tokenize("1999 1200"), ["1999", "1200"]);
  });

  test("short words and s-final nouns are not mangled", () => {
    assert.equal(stem("cat"), "cat");
    assert.equal(stem("status"), "status");
    assert.equal(stem("analysis"), "analysis");
    assert.equal(stem("glasses"), "glass");
  });
});

describe("BM25Index", () => {
  const corpus = [
    { id: "d1", text: "alpha beta gamma" },
    { id: "d2", text: "alpha delta" },
    { id: "d3", text: "epsilon zeta" },
    { id: "d4", text: "theta iota kappa lambda" },
  ];

  const build = () => {
    const index = new BM25Index();
    index.addMany(corpus);
    return index;
  };

  test("idf matches the Robertson-Sparck-Jones formula", () => {
    const index = build();
    assert.equal(index.documentFrequency("alpha"), 2);
    assert.ok(Math.abs(index.idf("alpha") - idf(4, 2)) < 1e-12);
    assert.ok(Math.abs(index.idf("alpha") - Math.LN2) < 1e-12);
    assert.ok(Math.abs(index.idf("gamma") - idf(4, 1)) < 1e-12);
    // Unseen terms fall back to the max-idf branch, not NaN.
    assert.ok(Math.abs(index.idf("nosuchterm") - idf(4, 0)) < 1e-12);
    assert.ok(index.idf("gamma") > index.idf("alpha"));
  });

  test("rarer terms outrank common ones", () => {
    const index = build();
    const hits = index.search("alpha gamma");
    assert.equal(hits[0].id, "d1");
    assert.equal(hits[1].id, "d2");
  });

  test("document length normalization favours the shorter document", () => {
    const index = new BM25Index();
    index.add("short", "alpha beta");
    index.add("long", "alpha beta gamma delta epsilon zeta theta iota kappa");
    const hits = index.search("alpha");
    assert.equal(hits[0].id, "short");
    assert.ok(hits[0].score > hits[1].score);

    // b = 0 disables length normalization, so both score identically.
    const flat = new BM25Index({ b: 0 });
    flat.add("short", "alpha beta");
    flat.add("long", "alpha beta gamma delta epsilon zeta theta iota kappa");
    const flatHits = flat.search("alpha");
    assert.ok(Math.abs(flatHits[0].score - flatHits[1].score) < 1e-12);
  });

  test("k1 and b are configurable", () => {
    const index = new BM25Index({ k1: 2.5, b: 0.3 });
    assert.equal(index.k1, 2.5);
    assert.equal(index.b, 0.3);
  });

  test("averageDocLength tracks incremental add and remove", () => {
    const index = new BM25Index();
    assert.equal(index.averageDocLength, 0);
    index.add("a", "alpha beta gamma");
    index.add("b", "delta");
    assert.equal(index.averageDocLength, 2);
    index.remove("b");
    assert.equal(index.averageDocLength, 3);
    index.remove("a");
    assert.equal(index.averageDocLength, 0);
    assert.equal(index.size, 0);
  });

  test("remove decrements df and drops empty postings", () => {
    const index = build();
    assert.equal(index.documentFrequency("alpha"), 2);
    assert.equal(index.remove("d2"), true);
    assert.equal(index.documentFrequency("alpha"), 1);
    assert.equal(index.documentFrequency("delta"), 0);
    assert.equal(index.stats().terms, 9);
    assert.equal(index.remove("d2"), false);
    assert.equal(index.search("delta").length, 0);
  });

  test("add-then-remove is equivalent to never adding", () => {
    const incremental = build();
    incremental.add("d5", "alpha alpha omega");
    incremental.remove("d5");

    const fresh = build();
    assert.deepEqual(incremental.stats(), fresh.stats());
    assert.deepEqual(incremental.search("alpha beta"), fresh.search("alpha beta"));
    assert.equal(incremental.documentFrequency("omega"), 0);
  });

  test("re-adding the same id replaces rather than double counts", () => {
    const index = new BM25Index();
    index.add("a", "alpha beta gamma");
    index.add("a", "delta");
    assert.equal(index.size, 1);
    assert.equal(index.averageDocLength, 1);
    assert.equal(index.documentFrequency("alpha"), 0);
    assert.equal(index.search("alpha").length, 0);
    assert.equal(index.search("delta")[0].id, "a");
  });

  test("stemmed query finds a morphological variant in the document", () => {
    const index = new BM25Index();
    index.add("m1", "I am allergic to shellfish");
    index.add("m2", "I prefer window seats on long flights");
    const hits = index.search("allergies");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, "m1");
    assert.ok(hits[0].score > 0);
  });

  test("a short query still scores a long document (overlapScore cap regression)", () => {
    const filler = Array.from({ length: 195 }, (_, i) => `filler${i}`).join(" ");
    const index = new BM25Index();
    index.add("long", `the user is allergic to shellfish and avoids seafood ${filler}`);
    index.add("other", "the user enjoys hiking in the mountains every weekend");
    const hits = index.search("shellfish allergy");
    assert.equal(hits[0].id, "long");
    // |A n B| / max(|A|,|B|) would have capped this near 0.025.
    assert.ok(hits[0].score > 0.5, `expected a meaningful score, got ${hits[0].score}`);
  });

  test("topK and filter bound the result set", () => {
    const index = build();
    assert.equal(index.search("alpha", 1).length, 1);
    const filtered = index.search("alpha", 10, (id) => id !== "d1");
    assert.deepEqual(filtered.map((hit) => hit.id), ["d2"]);
  });

  test("empty query and empty index return nothing", () => {
    assert.deepEqual(new BM25Index().search("alpha"), []);
    assert.deepEqual(build().search("the a of"), []);
  });

  test("scoreDocument agrees with search", () => {
    const index = build();
    const hits = index.search("alpha gamma");
    for (const hit of hits) {
      assert.ok(Math.abs(index.scoreDocument("alpha gamma", hit.id) - hit.score) < 1e-12);
    }
    assert.equal(index.scoreDocument("alpha", "missing"), 0);
  });

  test("a custom tokenizer is honoured", () => {
    const index = new BM25Index({ tokenizer: (text) => text.split("-") });
    index.add("a", "one-two-three");
    assert.equal(index.search("two")[0].id, "a");
  });
});
