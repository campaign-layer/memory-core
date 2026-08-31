import assert from "node:assert/strict";
import test from "node:test";

import { MemoryCoreClient } from "./client.js";

const FILTERS = { tenantId: "acme", appId: "planner", actorId: "alice" };

test("client rejects credential-bearing, ambiguous, and insecure remote base URLs", () => {
  assert.throws(
    () => new MemoryCoreClient({ baseUrl: "https://alice:secret@memory.example" }),
    /must not contain credentials/,
  );
  assert.throws(
    () => new MemoryCoreClient({ baseUrl: "https://memory.example?tenant=acme" }),
    /query string or fragment/,
  );
  assert.throws(
    () => new MemoryCoreClient({ baseUrl: "http://memory.example" }),
    /must use HTTPS/,
  );
  assert.doesNotThrow(() => new MemoryCoreClient({ baseUrl: "http://127.0.0.1:7401" }));
  assert.doesNotThrow(() => new MemoryCoreClient({ baseUrl: "http://localhost:7401" }));
});

test("client refuses redirects while forwarding credentials only to the configured origin", async () => {
  let seen: RequestInit | undefined;
  const client = new MemoryCoreClient({
    baseUrl: "https://memory.example",
    apiKey: "principal-secret",
    fetchImpl: (async (_input, init) => {
      seen = init;
      return new Response(JSON.stringify({ count: 0, hits: [] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  await client.search({ query: "release", filters: FILTERS });
  assert.equal(seen?.redirect, "error");
  assert.equal(new Headers(seen?.headers).get("x-api-key"), "principal-secret");
});

test("client enforces one whole-operation deadline", async () => {
  const client = new MemoryCoreClient({
    baseUrl: "https://memory.example",
    timeoutMs: 10,
    fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch,
  });

  await assert.rejects(
    client.search({ query: "release", filters: FILTERS }),
    /request deadline exceeded after 10ms/,
  );
});

test("client rejects oversized response bodies before JSON is trusted", async () => {
  const client = new MemoryCoreClient({
    baseUrl: "https://memory.example",
    maxResponseBytes: 32,
    fetchImpl: (async () => new Response(JSON.stringify({ payload: "x".repeat(100) }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch,
  });

  await assert.rejects(
    client.search({ query: "release", filters: FILTERS }),
    /response body exceeds 32 bytes/,
  );
});
