/**
 * One shared memory service, three independently authenticated agent principals.
 *
 *   docker compose up --build -d
 *   node examples/shared-agent-demo.mjs
 *
 * The defaults match docker-compose.yml and are intentionally local-demo only.
 */

const BASE = (process.env.MEMORY_CORE_URL ?? "http://127.0.0.1:7401").replace(/\/+$/, "");
const AGENTS = {
  claude: process.env.MEMORY_CORE_CLAUDE_KEY ?? "claude-local-demo",
  codex: process.env.MEMORY_CORE_CODEX_KEY ?? "codex-local-demo",
  hermes: process.env.MEMORY_CORE_HERMES_KEY ?? "hermes-local-demo",
};
const PRINCIPAL = {
  tenantId: "local",
  spaceId: "shared-demo",
  actorId: "demo-user",
};
const MEMORY_TEXT = "Prefers concise TypeScript examples for new agent integrations";

async function request(path, { apiKey, body, expectedStatus, timeoutMs = 10_000 } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned ${response.status} with non-JSON body`);
  }
  if (expectedStatus !== undefined) {
    if (response.status !== expectedStatus) {
      throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(payload)}`);
    }
    return payload;
  }
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function waitUntilReady() {
  const deadline = Date.now() + 60_000;
  let lastError = "no response";
  while (Date.now() < deadline) {
    try {
      const ready = await request("/ready", { timeoutMs: 2_000 });
      if (ready.ok) return ready;
      lastError = `readiness returned ${JSON.stringify(ready)}`;
    } catch (error) {
      // docker compose may still be starting Postgres or applying migrations.
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`memory-core did not become ready at ${BASE}; last error: ${lastError}`);
}

async function main() {
  if (Number.parseInt(process.versions.node, 10) < 20) {
    throw new Error(`this demo requires Node.js 20 or newer; found ${process.versions.node}`);
  }
  const ready = await waitUntilReady();
  if (ready.provider?.provider !== "postgres") {
    throw new Error(`expected the Compose Postgres provider, got ${JSON.stringify(ready.provider)}`);
  }
  console.log(`ready: ${ready.provider.provider}`);

  const claudeIdentity = { ...PRINCIPAL, appId: "claude" };
  const codexIdentity = { ...PRINCIPAL, appId: "codex" };
  await request("/v1/memory/search", {
    apiKey: AGENTS.claude,
    expectedStatus: 403,
    body: {
      query: "credential isolation",
      filters: codexIdentity,
    },
  });
  console.log("credential isolation: Claude cannot impersonate Codex");

  const stored = await request("/v1/memory/ingest", {
    apiKey: AGENTS.claude,
    body: {
      observations: [{
        ...claudeIdentity,
        memoryType: "preference",
        scope: "actor",
        text: MEMORY_TEXT,
        source: { sourceType: "claude" },
        confidence: 0.95,
        importance: 0.8,
      }],
    },
  });
  console.log(`claude stored: created=${stored.created} updated=${stored.updated}`);

  const recalled = await request("/v1/memory/search", {
    apiKey: AGENTS.codex,
    body: {
      query: "TypeScript integration examples",
      filters: codexIdentity,
      limit: 5,
    },
  });
  const shared = recalled.hits.find((hit) => hit.memory.text === MEMORY_TEXT);
  if (!shared) throw new Error("Codex did not recall Claude's actor-scoped memory");
  console.log(`codex recalled Claude memory: score=${shared.score.toFixed(3)} id=${shared.memory.id}`);

  const hermesIdentity = { ...PRINCIPAL, appId: "hermes" };
  const context = await request("/v1/memory/context", {
    apiKey: AGENTS.hermes,
    body: {
      query: "How should I explain a new integration?",
      filters: hermesIdentity,
      budget: { maxItems: 5, maxChars: 1200 },
    },
  });
  if (!context.contextText.includes(MEMORY_TEXT)) {
    throw new Error("Hermes context omitted the shared memory");
  }
  console.log("hermes prompt context:");
  console.log(context.contextText);
  console.log("\nPASS: one actor memory crossed Claude -> Codex -> Hermes principals without sharing credentials.");
}

main().catch((error) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
