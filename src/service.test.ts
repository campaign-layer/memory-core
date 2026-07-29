import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createMemoryCoreApp } from "./http.js";
import { DualLayerMemoryProvider } from "./providers/dual-layer-provider.js";
import { EnhancedMemoryProvider } from "./providers/enhanced-provider.js";
import { createMemoryProvider } from "./providers/factory.js";
import { FileProvider } from "./providers/file-provider.js";
import { InMemoryProvider } from "./providers/in-memory-provider.js";
import { MemoryCoreService } from "./service.js";
import type { MemoryObservation, MemoryRecord } from "./types.js";
import { tokenize } from "./utils.js";

test("ingest dedupes memories and buildContext returns selected memories", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);

  const payload = {
    observations: [
      {
        tenantId: "camp",
        appId: "pacer",
        actorId: "user_1",
        memoryType: "preference" as const,
        text: "Prefers concise outreach messages",
        source: { sourceType: "assistant_reply" },
      },
      {
        tenantId: "camp",
        appId: "pacer",
        actorId: "user_1",
        memoryType: "preference" as const,
        text: "Prefers concise outreach messages",
        source: { sourceType: "assistant_reply" },
      },
    ],
  };

  const ingestResult = await service.ingest(payload);
  assert.equal(ingestResult.created, 1);
  assert.equal(ingestResult.updated, 1);

  const context = await service.buildContext({
    query: "outreach style",
    filters: { tenantId: "camp", appId: "pacer", actorId: "user_1" },
  });

  assert.ok(context.selectedMemories.length >= 1);
  assert.match(context.contextText, /KNOWN ACTOR PROFILE|RELEVANT MEMORIES/);
});

test("compact archives expired records based on decay policy", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);

  const ingested = await service.ingest({
    observations: [
      {
        tenantId: "camp",
        appId: "pacer",
        actorId: "user_2",
        memoryType: "fact",
        text: "Signed to label in 2020",
        source: { sourceType: "profile_import" },
        decayPolicy: { kind: "time", ttlDays: 1 },
      },
    ],
  });

  // Age the record by moving lastSeenAt, which is how a memory actually goes
  // stale: time passes without it being re-observed. Backdating `observedAt`
  // deliberately no longer does this — event time is not decay time, or every
  // historical import would expire on arrival.
  const stale = ingested.records[0];
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await provider.update({ ...stale, lastSeenAt: twoDaysAgo });

  const compacted = await service.compact();
  assert.ok(compacted.archivedExpired >= 1, "a record untouched past its TTL must be archived");
  assert.equal(await provider.getById(stale.id), null, "an archived record must stop being returned");
});

test("file provider persists records across service instances", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "memory-core-test-"));
  const filePath = path.join(tempDir, "store.json");

  try {
    const providerA = new FileProvider(filePath);
    const serviceA = new MemoryCoreService(providerA);
    await serviceA.ingest({
      observations: [
        {
          tenantId: "camp",
          appId: "maitrix",
          actorId: "wallet_abc",
          memoryType: "goal",
          text: "Wants to post every Tuesday and Friday",
          source: { sourceType: "assistant_reply" },
        },
      ],
    });

    const providerB = new FileProvider(filePath);
    const serviceB = new MemoryCoreService(providerB);
    const profile = await serviceB.getProfile("camp", "maitrix", "wallet_abc");
    assert.equal(profile.count, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

const TENANT = { tenantId: "camp", appId: "pacer" };

function observation(actorId: string, text: string, extra: Partial<MemoryObservation> = {}): MemoryObservation {
  return {
    ...TENANT,
    actorId,
    memoryType: "fact",
    text,
    source: { sourceType: "assistant_reply" },
    ...extra,
  };
}

test("dual-layer provider round-trips records through list, profile, dedup and feedback", async () => {
  const provider = new DualLayerMemoryProvider();
  const service = new MemoryCoreService(provider);
  const filters = { ...TENANT, actorId: "user_dual" };

  try {
    const first = await service.ingest({
      observations: [
        observation("user_dual", "I am allergic to shellfish and peanuts"),
        observation("user_dual", "I live in Berlin"),
        observation("user_dual", "I prefer window seats", { memoryType: "preference" }),
      ],
    });
    assert.equal(first.created, 3);
    assert.equal(first.updated, 0);

    // Ingested records must be first-class: retrievable by list, profile, id and search.
    const listed = await provider.listByActor(TENANT.tenantId, TENANT.appId, "user_dual");
    assert.equal(listed.length, 3);

    const profile = await service.getProfile(TENANT.tenantId, TENANT.appId, "user_dual");
    assert.equal(profile.count, 3);
    assert.equal(profile.byType.fact.length, 2);
    assert.equal(profile.byType.preference.length, 1);

    const stored = first.records[0];
    assert.deepEqual(await provider.getById(stored.id), stored);

    const hits = await provider.search({ query: "allergies", filters });
    assert.ok(hits.length >= 1, "expected a hit for a morphological variant of a stored term");
    assert.equal(hits[0].memory.text, "I am allergic to shellfish and peanuts");

    // Dedup is provider-backed, so re-ingesting the same observation updates in place.
    const repeat = await service.ingest({
      observations: [observation("user_dual", "I am allergic to shellfish and peanuts")],
    });
    assert.equal(repeat.created, 0);
    assert.equal(repeat.updated, 1);
    assert.equal((await provider.listByActor(TENANT.tenantId, TENANT.appId, "user_dual")).length, 3);

    // Feedback must persist rather than silently drop.
    const positive = await service.applyFeedback({ memoryId: stored.id, signal: "positive" });
    assert.equal(positive.updated, true);
    const afterFeedback = await provider.getById(stored.id);
    assert.equal(afterFeedback?.stats.positiveCount, 1);
    assert.equal((await service.applyFeedback({ memoryId: "missing", signal: "positive" })).updated, false);

    // update() must persist; a superseded record leaves the active set.
    await provider.update({ ...afterFeedback!, status: "superseded" });
    assert.equal(await provider.getById(stored.id), null);
    assert.equal((await provider.listByActor(TENANT.tenantId, TENANT.appId, "user_dual")).length, 2);
  } finally {
    provider.close();
  }
});

test("dual-layer insights are extractive and never invent text", async () => {
  const provider = new DualLayerMemoryProvider();
  const service = new MemoryCoreService(provider);
  const filters = { ...TENANT, actorId: "user_extract" };
  const texts = [
    "The bluetooth pairing had an issue on my new gps unit. I have owned the unit since March.",
    "My laptop is a Samsung. I prefer the keyboard on my older one.",
  ];

  try {
    await service.ingest({
      observations: texts.map((text) => observation("user_extract", text, { memoryType: "episode" })),
    });

    const listed = await provider.listByActor(TENANT.tenantId, TENANT.appId, "user_extract");
    const insights = listed.filter((record) => record.source.sourceType === "dual_layer_insight");
    assert.ok(insights.length >= 1, "expected derived insights from multi-sentence events");

    // Every stored text must be a verbatim span of an ingested observation.
    for (const record of listed) {
      assert.ok(
        texts.some((text) => text.includes(record.text)),
        `stored text not present in any input: ${record.text}`,
      );
    }

    for (const hit of await provider.search({ query: "what was the first issue with the gps", filters })) {
      assert.ok(
        texts.some((text) => text.includes(hit.memory.text)),
        `search returned text absent from inputs: ${hit.memory.text}`,
      );
    }
  } finally {
    provider.close();
  }
});

test("dual-layer search cache keys isolate different filters", async () => {
  const provider = new DualLayerMemoryProvider();
  const service = new MemoryCoreService(provider);

  try {
    await service.ingest({
      observations: [
        observation("user_cache", "I ship releases on Tuesday", { threadId: "thread_a", metadata: { channel: "email" } }),
        observation("user_cache", "I review pull requests on Tuesday", {
          memoryType: "preference",
          threadId: "thread_b",
          metadata: { channel: "slack" },
        }),
      ],
    });

    const base = { ...TENANT, actorId: "user_cache" };
    const query = "Tuesday";

    // Prime the cache with the unfiltered query first, then confirm each narrower
    // filter is keyed separately instead of reusing the previous answer.
    const all = await provider.search({ query, filters: base });
    assert.equal(all.length, 2);

    const byType = await provider.search({ query, filters: { ...base, memoryTypes: ["preference"] } });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].memory.memoryType, "preference");

    const byThread = await provider.search({ query, filters: { ...base, threadId: "thread_a" } });
    assert.equal(byThread.length, 1);
    assert.equal(byThread[0].memory.threadId, "thread_a");

    const byMetadata = await provider.search({ query, filters: { ...base, metadata: { channel: "slack" } } });
    assert.equal(byMetadata.length, 1);
    assert.equal(byMetadata[0].memory.metadata.channel, "slack");

    const byScope = await provider.search({ query, filters: { ...base, scope: ["thread"] } });
    assert.equal(byScope.length, 0);

    const limited = await provider.search({ query, filters: base, limit: 1 });
    assert.equal(limited.length, 1);

    const scored = await provider.search({ query, filters: base, minScore: 0.99 });
    assert.equal(scored.length, 0);

    // Cached reads still agree with the uncached ones.
    assert.equal((await provider.search({ query, filters: base })).length, 2);
    assert.equal((await provider.search({ query, filters: { ...base, memoryTypes: ["preference"] } })).length, 1);
  } finally {
    provider.close();
  }
});

test("dual-layer fails closed when tenant or app is missing", async () => {
  const provider = new DualLayerMemoryProvider();
  const service = new MemoryCoreService(provider);

  try {
    await service.ingest({ observations: [observation("user_closed", "I am based in Lisbon")] });

    await assert.rejects(
      () => provider.search({ query: "Lisbon", filters: {} as never }),
      /tenantId and appId/,
    );
    await assert.rejects(
      () => provider.search({ query: "Lisbon", filters: { tenantId: "camp" } as never }),
      /tenantId and appId/,
    );
    assert.equal(
      (await provider.search({ query: "Lisbon", filters: { tenantId: "other", appId: "pacer" } })).length,
      0,
    );
  } finally {
    provider.close();
  }
});

test("enhanced provider context is extractive and emits no fabricated answer", async () => {
  const provider = new EnhancedMemoryProvider();
  const service = new MemoryCoreService(provider);
  const filters = { ...TENANT, actorId: "user_enhanced" };
  const query = "what was the first issue with the gps";
  const texts = [
    "The bluetooth pairing had an issue on my new gps unit",
    "I drove to the coast last weekend",
  ];

  await service.ingest({
    observations: texts.map((text) => observation("user_enhanced", text, { memoryType: "episode" })),
  });

  const context = await provider.buildEnhancedContext(query, filters, { maxItems: 5 });
  assert.ok(!("intelligentAnswer" in context), "provider must not synthesize answers");
  assert.ok(!/GPS system not functioning correctly/i.test(context.contextText));

  for (const memory of context.selectedMemories) {
    assert.ok(texts.includes(memory.text), `context included text absent from memories: ${memory.text}`);
  }

  // No word may appear in the output unless it came from a memory, the query, or the
  // fixed scaffolding of the context template.
  const scaffolding = new Set(tokenize("ENHANCED MEMORY SEARCH RESULTS score episode fact preference"));
  const allowed = new Set([...scaffolding, ...tokenize(query), ...texts.flatMap((text) => tokenize(text))]);
  const invented = tokenize(context.contextText).filter((token) => !allowed.has(token) && !/^\d/.test(token));
  assert.deepEqual(invented, [], `context contains invented tokens: ${invented.join(", ")}`);

  const built = await service.buildContext({ query, filters });
  assert.ok(!/GPS system not functioning correctly/i.test(built.contextText));
  for (const memory of built.selectedMemories) {
    assert.ok(texts.includes(memory.text), `buildContext leaked text absent from memories: ${memory.text}`);
  }
  // Was hardcoded to `Date.now() - Date.now()`, i.e. always exactly 0.
  assert.ok(built.processingTime > 0 && Number.isFinite(built.processingTime), `processingTime=${built.processingTime}`);
});

test("config accepts every provider kind the factory supports", async () => {
  for (const kind of ["in-memory", "file", "enhanced", "dual-layer", "postgres"] as const) {
    const config = loadConfig({ MEMORY_PROVIDER: kind, MEMORY_FILE_PATH: "/tmp/memory-core-test.json" });
    assert.equal(config.providerKind, kind);
    // The pg pool is lazy, so constructing the postgres provider opens no socket.
    const provider = createMemoryProvider({ kind: config.providerKind, filePath: config.filePath });
    assert.ok(provider);
    await provider.close?.();
  }

  assert.equal(loadConfig({}).providerKind, "in-memory");
  assert.throws(() => loadConfig({ MEMORY_PROVIDER: "not-a-provider" as never }));
});

test("http api accepts every memory type and preserves source metadata", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  const app = createMemoryCoreApp(service, { logger: () => {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${base}/v1/memory/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        observations: [
          {
            ...TENANT,
            actorId: "user_http",
            memoryType: "pattern",
            text: "Replies fastest on weekday mornings",
            source: { sourceType: "assistant_reply", metadata: { role: "user" } },
          },
          {
            ...TENANT,
            actorId: "user_http",
            memoryType: "summary",
            text: "Session covered onboarding and billing",
            source: { sourceType: "assistant_reply", sourceId: null },
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { created: number; records: Array<{ memoryType: string; source: { metadata?: Record<string, unknown> } }> };
    assert.equal(body.created, 2);
    assert.deepEqual(body.records.map((record) => record.memoryType).sort(), ["pattern", "summary"]);

    const pattern = body.records.find((record) => record.memoryType === "pattern");
    assert.equal(pattern?.source.metadata?.role, "user");

    const profile = await service.getProfile(TENANT.tenantId, TENANT.appId, "user_http");
    assert.equal(profile.byType.pattern.length, 1);
    assert.equal(profile.byType.summary.length, 1);
    assert.match(profile.summary, /Patterns|Summaries/);

    const rejected = await fetch(`${base}/v1/memory/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        observations: [{ ...TENANT, actorId: "user_http", memoryType: "not_a_type", text: "nope", source: { sourceType: "x" } }],
      }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --- Regressions from the kimi adversarial review of in-memory-provider.ts ---

function memRecord(over: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "tenantId" | "appId" | "actorId" | "text">): MemoryRecord {
  const now = new Date().toISOString();
  return {
    threadId: null,
    scope: "actor",
    memoryType: "fact",
    summary: null,
    metadata: {},
    confidence: 0.7,
    importance: 0.5,
    status: "active",
    source: { sourceType: "test" },
    decayPolicy: { kind: "none" },
    firstSeenAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    stats: { selectedCount: 0, positiveCount: 0, negativeCount: 0 },
    ...over,
  };
}

test("dedupe key cannot be forged across tenants by embedding the delimiter", async () => {
  const provider = new InMemoryProvider();
  // ("a b","c") and ("a","b c") produce the same naive delimiter-joined key.
  const left = memRecord({ id: "m1", tenantId: "a b", appId: "c", actorId: "u", text: "identical memory text" });
  const right = memRecord({ id: "m2", tenantId: "a", appId: "b c", actorId: "u", text: "identical memory text" });
  await provider.ingest([left, right]);

  assert.equal((await provider.findDuplicate(left))?.id, "m1");
  assert.equal((await provider.findDuplicate(right))?.id, "m2", "tenant 'a b'/'c' must not collide with 'a'/'b c'");
});

test("re-ingesting an id retires its previous dedupe key", async () => {
  const provider = new InMemoryProvider();
  await provider.ingest([memRecord({ id: "m1", tenantId: "t", appId: "a", actorId: "u", text: "original wording here" })]);
  await provider.ingest([memRecord({ id: "m1", tenantId: "t", appId: "a", actorId: "u", text: "replacement wording here" })]);

  const stale = memRecord({ id: "probe", tenantId: "t", appId: "a", actorId: "u", text: "original wording here" });
  assert.equal(await provider.findDuplicate(stale), null, "the old text must no longer resolve to m1");

  const current = memRecord({ id: "probe", tenantId: "t", appId: "a", actorId: "u", text: "replacement wording here" });
  assert.equal((await provider.findDuplicate(current))?.id, "m1");
});

test("archiving one record does not evict another record's dedupe entry", async () => {
  const provider = new InMemoryProvider();
  // Two live records share a dedupe key; the map holds one id.
  const a = memRecord({ id: "m1", tenantId: "t", appId: "a", actorId: "u", text: "shared duplicate text" });
  const b = memRecord({ id: "m2", tenantId: "t", appId: "a", actorId: "u", text: "shared duplicate text" });
  await provider.ingest([a, b]);

  await provider.update({ ...a, status: "superseded" });
  await provider.compact();

  const probe = memRecord({ id: "probe", tenantId: "t", appId: "a", actorId: "u", text: "shared duplicate text" });
  const found = await provider.findDuplicate(probe);
  assert.ok(found, "the surviving duplicate must still be discoverable");
  assert.equal(found.id, "m2");
});

test("non-active records stay out of the search index", async () => {
  const provider = new InMemoryProvider();
  const filters = { tenantId: "t", appId: "a", actorId: "u" };
  const rec = memRecord({ id: "m1", tenantId: "t", appId: "a", actorId: "u", text: "quarterly zarvox reconciliation" });
  await provider.ingest([rec]);
  assert.equal((await provider.search({ query: "zarvox reconciliation", filters })).length, 1);

  await provider.update({ ...rec, status: "archived" });
  assert.equal((await provider.search({ query: "zarvox reconciliation", filters })).length, 0);
  assert.equal((await provider.health()).detail?.includes("indexed=0"), true, "archived record must be unindexed");
});

test("bm25 rejects out-of-range parameters and honours topK=0", async () => {
  const { BM25Index } = await import("./retrieval/bm25.js");
  assert.throws(() => new BM25Index({ b: 1.5 }), RangeError);
  assert.throws(() => new BM25Index({ b: -0.1 }), RangeError);
  assert.throws(() => new BM25Index({ k1: -1 }), RangeError);

  const index = new BM25Index();
  index.add("d1", "alpha beta gamma");
  assert.equal(index.search("alpha", 0).length, 0, "topK=0 must return nothing, not everything");
  assert.equal(index.search("alpha", 5).length, 1);
});

test("a historical import stays retrievable under the default decay policy", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  const filters = { tenantId: "camp", appId: "import", actorId: "u_hist" };

  // Event time is years in the past; the default decay is time/180d. Before the
  // fix, lastSeenAt was set to observedAt, so the record was expired on arrival
  // and ingest still reported created=1 — silent loss behind a success response.
  const result = await service.ingest({
    observations: [
      {
        ...filters,
        memoryType: "fact",
        text: "Attended the support group in May 2023",
        source: { sourceType: "history_import" },
        observedAt: "2023-05-07T10:00:00.000Z",
      },
    ],
  });
  assert.equal(result.created, 1);

  const stored = result.records[0];
  assert.ok(await provider.getById(stored.id), "an imported memory must be retrievable by id");
  assert.equal((await provider.listByActor(filters.tenantId, filters.appId, filters.actorId)).length, 1);
  assert.equal((await service.getProfile(filters.tenantId, filters.appId, filters.actorId)).count, 1);
  assert.equal((await provider.search({ query: "support group May 2023", filters })).length, 1);
  assert.equal((await service.compact()).archivedExpired, 0, "it must not be archived as expired");

  // Event time is preserved for temporal reasoning; decay reads lastSeenAt.
  assert.equal(stored.firstSeenAt, "2023-05-07T10:00:00.000Z", "firstSeenAt keeps the event time");
  assert.ok(stored.lastSeenAt > "2026-01-01", `lastSeenAt should be ingest time, got ${stored.lastSeenAt}`);
});
