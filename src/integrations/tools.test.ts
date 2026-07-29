import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryProvider } from "../providers/in-memory-provider.js";
import { MemoryCoreService } from "../service.js";
import {
  MEMORY_TOOLS,
  MEMORY_TOOL_NAMES,
  assertIdentity,
  createEmbeddedBackend,
  createRemoteBackend,
  dispatch,
  getMemoryTool,
  toAnthropicTools,
  toJsonSchema,
  toOpenAITools,
  type MemoryToolContext,
} from "./tools.js";

const IDENTITY = { tenantId: "acme", appId: "test-app", actorId: "user_1", threadId: "t1" };

function newContext(): { ctx: MemoryToolContext; provider: InMemoryProvider } {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  return {
    provider,
    ctx: {
      backend: createEmbeddedBackend(service, provider),
      identity: IDENTITY,
      sourceType: "unit-test",
    },
  };
}

test("tool surface stays small and stable", () => {
  assert.equal(MEMORY_TOOLS.length, 6);
  assert.deepEqual(
    MEMORY_TOOLS.map((tool) => tool.name),
    [...MEMORY_TOOL_NAMES],
  );
  for (const tool of MEMORY_TOOLS) {
    assert.ok(tool.description.length > 80, `${tool.name} needs a real description`);
  }
  assert.equal(getMemoryTool("nope"), undefined);
});

test("schemas reject bad input", () => {
  const remember = getMemoryTool("remember")!.schema;
  assert.equal(remember.safeParse({ text: "no" }).success, false, "text under 4 chars");
  assert.equal(remember.safeParse({}).success, false, "text is required");
  assert.equal(remember.safeParse({ text: "valid text", type: "banana" }).success, false);
  assert.equal(remember.safeParse({ text: "valid text", importance: 5 }).success, false);

  const recall = getMemoryTool("recall")!.schema;
  assert.equal(recall.safeParse({ query: "hi", limit: 99 }).success, false);
  assert.equal(recall.safeParse({ query: "hi", types: [] }).success, false);

  const feedback = getMemoryTool("feedback")!.schema;
  assert.equal(feedback.safeParse({ memoryId: "m1", signal: "positive" }).success, false);
  assert.equal(feedback.safeParse({ memoryId: "m1", signal: "useful" }).success, true);
});

test("schemas apply agent-friendly defaults", () => {
  const parsed = getMemoryTool("remember")!.schema.parse({ text: "Uses pnpm everywhere" });
  assert.deepEqual(parsed, {
    text: "Uses pnpm everywhere",
    type: "fact",
    importance: 0.5,
    scope: "actor",
  });
});

test("dispatch round-trips remember -> recall", async () => {
  const { ctx } = newContext();

  const stored = await dispatch(
    "remember",
    { text: "Deploys with pnpm and never npm", type: "preference", importance: 0.9 },
    ctx,
  );
  assert.equal(stored.ok, true);
  const id = (stored.data as { id: string }).id;
  assert.match(id, /^mem_/);

  const found = await dispatch("recall", { query: "pnpm deploys" }, ctx);
  assert.equal(found.ok, true);
  const hits = found.data as Array<{ id: string; text: string; score: number }>;
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, id);
  assert.match(found.text, /pnpm/);
  assert.match(found.text, new RegExp(`id=${id}`));
});

test("dispatch build_context returns a promptable block", async () => {
  const { ctx } = newContext();
  await dispatch("remember", { text: "Runs Node 22 in production", type: "project" }, ctx);

  const empty = await dispatch("build_context", { query: "unrelated topic entirely" }, ctx);
  assert.equal(empty.ok, true);
  assert.match(empty.text, /KNOWN ACTOR PROFILE/);

  const block = await dispatch("build_context", { query: "node version", maxChars: 900 }, ctx);
  assert.match(block.text, /Node 22/);
  assert.ok(block.text.length <= 900 + 200);
});

test("dispatch feedback, forget and supersede close the correction loop", async () => {
  const { ctx } = newContext();
  const stored = await dispatch("remember", { text: "Lives in Berlin", type: "fact" }, ctx);
  const id = (stored.data as { id: string }).id;

  const rated = await dispatch("feedback", { memoryId: id, signal: "used" }, ctx);
  assert.equal(rated.ok, true);
  assert.equal(
    (await dispatch("feedback", { memoryId: "mem_missing", signal: "useful" }, ctx)).ok,
    false,
  );

  const moved = await dispatch(
    "supersede",
    { memoryId: id, newText: "Lives in Lisbon", reason: "relocated" },
    ctx,
  );
  assert.equal(moved.ok, true);
  const newId = (moved.data as { newId: string }).newId;

  const afterMove = await dispatch("recall", { query: "lives in" }, ctx);
  assert.match(afterMove.text, /Lisbon/);
  assert.doesNotMatch(afterMove.text, /Berlin/);

  const forgotten = await dispatch("forget", { memoryId: newId, reason: "wrong" }, ctx);
  assert.equal(forgotten.ok, true);
  const afterForget = await dispatch("recall", { query: "lives in" }, ctx);
  assert.equal((afterForget.data as unknown[]).length, 0);
  assert.match(afterForget.text, /No memories stored/);

  const again = await dispatch("forget", { memoryId: newId }, ctx);
  assert.equal(again.ok, false, "double forget is reported, not silently accepted");
});

test("supersede refuses an identical replacement", async () => {
  const { ctx } = newContext();
  const stored = await dispatch("remember", { text: "Prefers dark mode" }, ctx);
  const id = (stored.data as { id: string }).id;
  const result = await dispatch("supersede", { memoryId: id, newText: "Prefers dark mode" }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.text, /identical/);
});

test("dispatch reports bad args instead of throwing", async () => {
  const { ctx } = newContext();
  const result = await dispatch("remember", { text: "no" }, ctx);
  assert.equal(result.ok, false);
  assert.match(result.text, /Invalid arguments for remember/);

  const unknown = await dispatch("teleport", {}, ctx);
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /Unknown memory tool/);
});

test("missing identity fails loudly", async () => {
  const { ctx } = newContext();
  await assert.rejects(
    () => dispatch("remember", { text: "should never be stored" }, { ...ctx, identity: { tenantId: "acme", appId: "", actorId: "" } as never }),
    /Missing memory identity: appId, actorId/,
  );
  assert.throws(() => assertIdentity(undefined), /Missing memory identity/);
  assert.deepEqual(assertIdentity({ tenantId: " a ", appId: "b", actorId: "c" }), {
    tenantId: "a",
    appId: "b",
    actorId: "c",
    threadId: undefined,
  });
});

test("writes are pinned to the configured identity", async () => {
  const { ctx, provider } = newContext();
  // Model-supplied identity fields must be ignored, not honoured.
  await dispatch("remember", { text: "Tenant hijack attempt", tenantId: "evil", actorId: "root" } as never, ctx);
  const records = provider.dumpRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0]!.tenantId, "acme");
  assert.equal(records[0]!.actorId, "user_1");
  assert.equal(records[0]!.source.sourceType, "unit-test");

  for (const schema of Object.values(toJsonSchema())) {
    for (const key of Object.keys(schema.properties ?? {})) {
      assert.ok(
        !["tenantId", "appId", "actorId"].includes(key),
        `${key} must never be model-supplied`,
      );
    }
  }
});

test("remote backend downranks when it cannot archive", async () => {
  const provider = new InMemoryProvider();
  const service = new MemoryCoreService(provider);
  // Stand-in for MemoryCoreClient: same method shapes, no status endpoint.
  const ctx: MemoryToolContext = {
    identity: IDENTITY,
    backend: createRemoteBackend({
      ingest: async (input) => {
        const result = await service.ingest(input);
        return { created: result.created, updated: result.updated, records: result.records };
      },
      search: async (input) => {
        const hits = await service.search(input);
        return { count: hits.length, hits };
      },
      buildContext: (input) => service.buildContext(input),
      applyFeedback: (input) => service.applyFeedback(input),
    }),
  };
  assert.equal(ctx.backend.kind, "remote");
  assert.equal(ctx.backend.retire, undefined);

  const stored = await dispatch("remember", { text: "Uses Vitest for unit tests" }, ctx);
  const id = (stored.data as { id: string }).id;

  const forgotten = await dispatch("forget", { memoryId: id }, ctx);
  assert.equal(forgotten.ok, true);
  assert.match(forgotten.text, /not archived/);
  assert.equal((forgotten.data as { archived: boolean }).archived, false);
});

test("anthropic export is structurally valid", () => {
  const tools = toAnthropicTools();
  assert.equal(tools.length, MEMORY_TOOLS.length);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z_]+$/);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0);
    assert.equal(tool.input_schema.type, "object");
    assert.equal(tool.input_schema.additionalProperties, false);
    assert.ok(Array.isArray(tool.input_schema.required));
    for (const [key, prop] of Object.entries(tool.input_schema.properties ?? {})) {
      assert.ok(prop.type, `${tool.name}.${key} needs a type`);
      assert.ok(prop.description, `${tool.name}.${key} needs a description`);
    }
    // Round-trips through JSON without loss.
    assert.deepEqual(JSON.parse(JSON.stringify(tool)), tool);
  }

  const remember = tools.find((tool) => tool.name === "remember")!;
  assert.deepEqual(remember.input_schema.required, ["text"]);
  assert.equal(remember.input_schema.properties!.text!.minLength, 4);
  assert.equal(remember.input_schema.properties!.type!.default, "fact");
  assert.deepEqual(remember.input_schema.properties!.importance, {
    description: remember.input_schema.properties!.importance!.description,
    type: "number",
    minimum: 0,
    maximum: 1,
    default: 0.5,
  });
});

test("openai export is structurally valid", () => {
  const tools = toOpenAITools();
  assert.equal(tools.length, MEMORY_TOOLS.length);
  for (const tool of tools) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.name);
    assert.ok(tool.function.description);
    assert.equal(tool.function.parameters.type, "object");
  }
  const recall = tools.find((tool) => tool.function.name === "recall")!;
  assert.deepEqual(recall.function.parameters.required, ["query"]);
  assert.deepEqual(recall.function.parameters.properties!.types, {
    description: recall.function.parameters.properties!.types!.description,
    type: "array",
    items: { type: "string", enum: ["fact", "preference", "goal", "project", "episode", "instruction", "tool_outcome"] },
    minItems: 1,
    maxItems: 7,
  });
});

test("json schema export covers every tool", () => {
  const schemas = toJsonSchema();
  assert.deepEqual(Object.keys(schemas).sort(), [...MEMORY_TOOL_NAMES].sort());
  assert.deepEqual(schemas.supersede.required, ["memoryId", "newText"]);
  assert.deepEqual(schemas.feedback.properties!.signal!.enum, ["used", "useful", "not_useful"]);
  assert.equal(schemas.build_context.properties!.maxItems!.type, "integer");
});
