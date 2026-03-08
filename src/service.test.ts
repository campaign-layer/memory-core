import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileProvider } from "./providers/file-provider.js";
import { InMemoryProvider } from "./providers/in-memory-provider.js";
import { MemoryCoreService } from "./service.js";

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

  await service.ingest({
    observations: [
      {
        tenantId: "camp",
        appId: "pacer",
        actorId: "user_2",
        memoryType: "fact",
        text: "Signed to label in 2020",
        source: { sourceType: "profile_import" },
        observedAt: "2020-01-01T00:00:00.000Z",
        decayPolicy: { kind: "time", ttlDays: 1 },
      },
    ],
  });

  const compacted = await service.compact();
  assert.ok(compacted.archivedExpired >= 1);
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
