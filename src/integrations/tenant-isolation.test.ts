import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProvider } from "../providers/in-memory-provider.js";
import { MemoryCoreService } from "../service.js";
import { createEmbeddedBackend, dispatch, type MemoryToolContext } from "./tools.js";

// memoryId is model-supplied on forget/supersede/feedback. Ids are globally
// unique, so without tenant scoping an agent can reach another tenant's record.
test("an agent cannot reach another tenant's memory by id", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  const backend = createEmbeddedBackend(service, provider);

  const victim: MemoryToolContext = {
    backend,
    identity: { tenantId: "victim-co", appId: "app", actorId: "victim_user" },
    sourceType: "unit-test",
  };
  const attacker: MemoryToolContext = {
    backend,
    identity: { tenantId: "attacker-co", appId: "app", actorId: "attacker_user" },
    sourceType: "unit-test",
  };

  const stored = await dispatch("remember", { text: "Victim ships on Fridays", type: "fact" }, victim);
  assert.equal(stored.ok, true, stored.text);
  const victimId = (stored.data as { id: string }).id;
  assert.match(victimId, /^mem_/, "remember must return the new id under data.id");

  // Each attempt must be refused by the tenant guard, NOT by argument validation
  // — a validation error would make this test pass while proving nothing.
  const refusals = [
    ["forget", await dispatch("forget", { memoryId: victimId, reason: "not mine" }, attacker)],
    ["supersede", await dispatch("supersede", { memoryId: victimId, newText: "Victim ships on Mondays" }, attacker)],
    ["feedback", await dispatch("feedback", { memoryId: victimId, signal: "not_useful" }, attacker)],
  ] as const;

  for (const [name, result] of refusals) {
    assert.equal(result.ok, false, `${name} must refuse an id from another tenant`);
    assert.doesNotMatch(
      result.text,
      /Invalid arguments/i,
      `${name} was rejected by validation, not by the tenant guard — the assertion is vacuous`,
    );
  }

  // The victim's record must be untouched on every axis.
  const survivor = await provider.getById(victimId, { tenantId: "victim-co", appId: "app" });
  assert.ok(survivor, "victim memory must still exist");
  assert.equal(survivor.status, "active", "victim memory must not have been archived");
  assert.equal(survivor.text, "Victim ships on Fridays", "victim memory text must be unchanged");
  assert.equal(survivor.stats.negativeCount, 0, "victim memory must not have been downranked");

  // The attacker must not be able to read it either.
  assert.equal(await provider.getById(victimId, { tenantId: "attacker-co", appId: "app" }), null);

  // And the victim can still reach its own memory through the tool surface.
  const recalled = await dispatch("recall", { query: "ships on Fridays" }, victim);
  assert.equal(recalled.ok, true);
});

test("the owning tenant can still forget and supersede its own memory", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  const ctx: MemoryToolContext = {
    backend: createEmbeddedBackend(service, provider),
    identity: { tenantId: "acme", appId: "app", actorId: "u1" },
    sourceType: "unit-test",
  };

  const a = await dispatch("remember", { text: "Deploys happen on Tuesday", type: "fact" }, ctx);
  const aId = (a.data as { id: string }).id;
  const moved = await dispatch("supersede", { memoryId: aId, newText: "Deploys happen on Thursday" }, ctx);
  assert.equal(moved.ok, true, moved.text);

  const old = await provider.getById(aId, { tenantId: "acme", appId: "app" });
  assert.equal(old, null, "the superseded record must leave the active set");

  const b = await dispatch("remember", { text: "Uses pnpm for installs", type: "fact" }, ctx);
  const bId = (b.data as { id: string }).id;
  const gone = await dispatch("forget", { memoryId: bId, reason: "wrong" }, ctx);
  assert.equal(gone.ok, true, gone.text);
  assert.equal(await provider.getById(bId, { tenantId: "acme", appId: "app" }), null);
});
