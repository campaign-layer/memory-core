/**
 * End-to-end walkthrough of the memory-core HTTP API.
 *
 * No dependencies — uses Node 18+ global fetch.
 *
 *   npm run dev                      # terminal 1
 *   node examples/quickstart.mjs     # terminal 2
 *
 * Point it elsewhere with MEMORY_CORE_URL, and add auth with MEMORY_CORE_API_KEY
 * if the target server sets MEMORY_CORE_API_KEYS.
 */

const BASE = process.env.MEMORY_CORE_URL ?? "http://localhost:7401";
const API_KEY = process.env.MEMORY_CORE_API_KEY;

const IDENTITY = {
  tenantId: "demo",
  appId: "quickstart",
  actorId: "user_42",
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}, non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function step(n, label) {
  console.log(`\n${n}. ${label}`);
}

async function main() {
  step(1, "Check the service is up");
  const ready = await call("GET", "/ready");
  console.log(`   provider=${ready.provider.provider} detail=${ready.provider.detail}`);

  step(2, "Ingest a few memories");
  // memory-core does NOT extract: every observation must already be an atomic,
  // self-contained statement. Sending raw conversation turns stores raw turns.
  const ingest = await call("POST", "/v1/memory/ingest", {
    observations: [
      {
        ...IDENTITY,
        memoryType: "preference",
        text: "Prefers vegetarian Italian restaurants",
        source: { sourceType: "chat" },
        confidence: 0.9,
        importance: 0.8,
      },
      {
        ...IDENTITY,
        memoryType: "fact",
        text: "Lives in Lisbon and works in the Alcantara district",
        source: { sourceType: "chat" },
      },
      {
        ...IDENTITY,
        memoryType: "goal",
        text: "Wants to run a half marathon before the end of the year",
        source: { sourceType: "chat" },
        importance: 0.7,
      },
    ],
  });
  console.log(`   created=${ingest.created} updated=${ingest.updated}`);

  step(3, "Ingest the same preference again (exact-text dedupe)");
  const again = await call("POST", "/v1/memory/ingest", {
    observations: [
      {
        ...IDENTITY,
        memoryType: "preference",
        text: "Prefers vegetarian Italian restaurants",
        source: { sourceType: "chat" },
      },
    ],
  });
  console.log(`   created=${again.created} updated=${again.updated}   <- dedupe is exact text only`);

  step(4, "Search");
  const search = await call("POST", "/v1/memory/search", {
    query: "italian restaurant",
    filters: IDENTITY,
    limit: 5,
  });
  for (const hit of search.hits) {
    console.log(`   ${hit.score.toFixed(3)}  [${hit.memory.memoryType}] ${hit.memory.text}`);
  }

  step(5, "Build a context block to splice into a system prompt");
  const context = await call("POST", "/v1/memory/context", {
    query: "recommend an italian restaurant for dinner",
    filters: IDENTITY,
    budget: { maxItems: 5, maxChars: 1200 },
  });
  console.log(`   ${context.selectedMemories.length} memories, ${context.processingTime} ms`);
  console.log(
    context.contextText
      .split("\n")
      .map((line) => `   | ${line}`)
      .join("\n"),
  );

  step(6, "Report that a memory was useful");
  const top = context.selectedMemories[0];
  if (top) {
    const feedback = await call("POST", "/v1/memory/feedback", {
      memoryId: top.id,
      signal: "positive",
      tenantId: IDENTITY.tenantId,
      appId: IDENTITY.appId,
    });
    console.log(`   updated=${feedback.updated} for ${top.id}`);
  }

  step(7, "Read the actor profile");
  const profile = await call(
    "GET",
    `/v1/memory/profile/${IDENTITY.tenantId}/${IDENTITY.appId}/${IDENTITY.actorId}`,
  );
  console.log(`   ${profile.count} memories`);
  console.log(
    profile.summary
      .split("\n")
      .map((line) => `   | ${line}`)
      .join("\n"),
  );

  step(8, "Archive decay-expired records");
  const compact = await call("POST", "/v1/memory/compact");
  // archivedSuperseded is always 0: nothing on the write path sets that status.
  console.log(`   ${JSON.stringify(compact)}`);

  step(9, "The lexical blind spot, on purpose");
  // "where should we eat tonight" shares no terms with "Prefers vegetarian Italian
  // restaurants". BM25 gates on term overlap, so with MEMORY_EMBEDDER unset this
  // returns nothing. Restart the server with MEMORY_EMBEDDER=local and run again:
  // the vector side of the hybrid retriever finds it. This is the measured
  // preference-family gap described in docs/BENCHMARKS.md.
  const semantic = await call("POST", "/v1/memory/search", {
    query: "where should we eat tonight",
    filters: IDENTITY,
    limit: 5,
  });
  console.log(`   hits=${semantic.count} (embedder=${ready.provider.detail.split("embedder=")[1] ?? "?"})`);
  if (semantic.count === 0) {
    console.log("   No term overlap, so BM25-only returns nothing.");
    console.log("   Retry with: MEMORY_EMBEDDER=local npm run dev");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  console.error(`Is memory-core running at ${BASE}? Start it with: npm run dev`);
  process.exit(1);
});
