import assert from "node:assert/strict";
import test from "node:test";

import { HttpDeadlineError, postJson } from "./http.js";

test("hosted JSON transport clamps Retry-After and refuses redirects", async () => {
  let calls = 0;
  const redirects: Array<RequestRedirect | undefined> = [];
  const started = Date.now();
  const result = await postJson<{ ok: boolean }>(
    "https://models.example/v1/embed",
    { input: "hello" },
    { authorization: "Bearer secret" },
    {
      maxRetries: 1,
      timeoutMs: 200,
      maxRetryAfterMs: 5,
      fetchImpl: (async (_input, init) => {
        calls += 1;
        redirects.push(init?.redirect);
        if (calls === 1) {
          return new Response("busy", { status: 429, headers: { "retry-after": "3600" } });
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(redirects, ["error", "error"]);
  assert.ok(Date.now() - started < 150, "Retry-After must never control wall-clock latency");
});

test("hosted JSON transport applies one deadline across a hung attempt", async () => {
  await assert.rejects(
    postJson(
      "https://models.example/v1/embed",
      { input: "hello" },
      {},
      {
        maxRetries: 3,
        timeoutMs: 10,
        fetchImpl: (async (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as typeof fetch,
      },
    ),
    HttpDeadlineError,
  );
});

test("hosted JSON transport deadline includes a stalled response body", async () => {
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":'));
    },
  });
  await assert.rejects(
    postJson(
      "https://models.example/v1/embed",
      { input: "hello" },
      {},
      {
        maxRetries: 0,
        timeoutMs: 10,
        fetchImpl: (async () => new Response(stalled)) as typeof fetch,
      },
    ),
    HttpDeadlineError,
  );
});

test("hosted JSON transport rejects an oversized successful body", async () => {
  await assert.rejects(
    postJson(
      "https://models.example/v1/embed",
      { input: "hello" },
      {},
      {
        maxRetries: 0,
        maxResponseBytes: 32,
        fetchImpl: (async () => new Response(JSON.stringify({ value: "x".repeat(100) }))) as typeof fetch,
      },
    ),
    /response body exceeds 32 bytes/,
  );
});
