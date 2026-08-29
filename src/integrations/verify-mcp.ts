import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End-to-end smoke check: spawns src/integrations/mcp-server.ts over stdio,
// lists tools and drives a real remember -> recall -> forget cycle.
// Run: npx tsx src/integrations/verify-mcp.ts

const serverPath = path.resolve(fileURLToPath(new URL("./mcp-server.ts", import.meta.url)));

interface TextResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const typed = result as TextResult;
  return (typed.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function show(label: string, result: unknown): string {
  const typed = result as TextResult;
  const flag = typed.isError ? "ERROR" : "ok";
  const body = textOf(result);
  console.log(`\n--- ${label} [${flag}] ---\n${body}`);
  return body;
}

async function connect(
  env: Record<string, string>,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    stderr: "inherit",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      MEMORY_TENANT_ID: "acme",
      MEMORY_ACTOR_ID: "user_42",
      ...env,
    },
  });
  const client = new Client({ name: "verify-harness", version: "0.0.1" });
  await client.connect(transport);
  return { client, transport };
}

function embeddedEnv(storePath: string): Record<string, string> {
  return {
    MEMORY_APP_ID: "verify-harness",
    MEMORY_THREAD_ID: "thread_1",
    MEMORY_PROVIDER: "file",
    MEMORY_FILE_PATH: storePath,
  };
}

/**
 * Remote mode against a running memory-core service.
 * Enable with VERIFY_REMOTE_URL=http://127.0.0.1:7455 (plus VERIFY_REMOTE_API_KEY).
 */
async function verifyRemote(check: (label: string, ok: boolean) => void): Promise<void> {
  const url = process.env.VERIFY_REMOTE_URL;
  if (!url) {
    console.log("\n(skipping remote mode: set VERIFY_REMOTE_URL to a running memory-core service)");
    return;
  }

  console.log(`\n================ REMOTE MODE (${url}) ================`);
  const { client } = await connect({
    MEMORY_APP_ID: "remote-harness",
    MEMORY_CORE_URL: url,
    ...(process.env.VERIFY_REMOTE_API_KEY
      ? { MEMORY_CORE_API_KEY: process.env.VERIFY_REMOTE_API_KEY }
      : {}),
  });

  const tools = await client.listTools();
  check("remote mode advertises the same 6 tools", tools.tools.length === 6);

  const stored = show(
    "remote remember",
    await client.callTool({
      name: "remember",
      arguments: {
        text: "Runs memory-core behind an nginx reverse proxy",
        type: "project",
        importance: 0.8,
      },
    }),
  );
  const id = /id=(\S+)/.exec(stored)?.[1];
  check("remote remember returned an id", Boolean(id));

  const recalled = show(
    "remote recall",
    await client.callTool({ name: "recall", arguments: { query: "nginx reverse proxy" } }),
  );
  check("remote recall round-tripped over HTTP", recalled.includes("nginx"));

  const superseded = show(
    "remote supersede",
    await client.callTool({
      name: "supersede",
      arguments: {
        memoryId: id,
        newText: "Runs memory-core behind a Caddy reverse proxy",
        reason: "proxy changed",
      },
    }),
  );
  const replacementId = /id=(\S+)/.exec(superseded)?.[1];
  check("remote supersede returned a replacement id", Boolean(replacementId));

  const afterSupersede = show(
    "remote recall after supersede",
    await client.callTool({ name: "recall", arguments: { query: "reverse proxy" } }),
  );
  check("remote supersede retired old memory", !afterSupersede.includes("nginx"));
  check("remote supersede recalled replacement", afterSupersede.includes("Caddy"));

  const forgotten = show(
    "remote forget",
    await client.callTool({ name: "forget", arguments: { memoryId: replacementId, reason: "remote check" } }),
  );
  check("remote forget archives through scoped status API", forgotten.includes("will not be recalled"));

  const missing = await client.callTool({
    name: "feedback",
    arguments: { memoryId: "mem_nope", signal: "useful" },
  });
  show("remote feedback (unknown id)", missing);
  check("unknown id reported as an error", (missing as TextResult).isError === true);

  await client.close();
}

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "memory-core-mcp-"));
  const storePath = path.join(dir, "store.json");
  let failures = 0;
  const check = (label: string, condition: boolean) => {
    console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
    if (!condition) failures += 1;
  };

  console.log("================ EMBEDDED MODE ================");
  const first = await connect(embeddedEnv(storePath));

  const tools = await first.client.listTools();
  console.log("\n--- tools/list ---");
  for (const tool of tools.tools) {
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    console.log(`  ${tool.name}(${required.join(", ")}) :: ${tool.description?.slice(0, 72)}...`);
  }
  check("6 tools advertised", tools.tools.length === 6);

  const remembered = show(
    "remember",
    await first.client.callTool({
      name: "remember",
      arguments: {
        text: "Prefers Postgres with pgvector over Pinecone for vector search",
        type: "preference",
        importance: 0.9,
      },
    }),
  );
  const memoryId = /id=(\S+)/.exec(remembered)?.[1];
  check("remember returned an id", Boolean(memoryId));

  await first.client.callTool({
    name: "remember",
    arguments: { text: "Ships TypeScript ESM targeting Node 22", type: "project" },
  });

  const recalled = show(
    "recall",
    await first.client.callTool({ name: "recall", arguments: { query: "vector search database" } }),
  );
  check("recall found the stored preference", recalled.includes("pgvector"));

  show(
    "build_context",
    await first.client.callTool({
      name: "build_context",
      arguments: { query: "which database should we use", maxItems: 5, maxChars: 600 },
    }),
  );

  const badArgs = await first.client.callTool({ name: "remember", arguments: { text: "no" } });
  show("remember (invalid args)", badArgs);
  check("short text rejected", (badArgs as TextResult).isError === true);

  show(
    "feedback",
    await first.client.callTool({ name: "feedback", arguments: { memoryId, signal: "useful" } }),
  );

  await first.client.close();

  // Second process: proves persistence and a clean restart.
  const second = await connect(embeddedEnv(storePath));
  const recalledAgain = show(
    "recall after restart",
    await second.client.callTool({ name: "recall", arguments: { query: "vector search database" } }),
  );
  check("memory survived a server restart", recalledAgain.includes("pgvector"));

  show(
    "supersede",
    await second.client.callTool({
      name: "supersede",
      arguments: {
        memoryId,
        newText: "Prefers Postgres with pgvector over Qdrant for vector search",
        reason: "switched comparison target",
      },
    }),
  );

  const afterSupersede = show(
    "recall after supersede",
    await second.client.callTool({ name: "recall", arguments: { query: "vector search database" } }),
  );
  check("old memory no longer recalled", !afterSupersede.includes("Pinecone"));
  check("replacement recalled", afterSupersede.includes("Qdrant"));

  const newId = /id=(\S+)/.exec(afterSupersede)?.[1];
  show("forget", await second.client.callTool({ name: "forget", arguments: { memoryId: newId, reason: "test cleanup" } }));
  const afterForget = show(
    "recall after forget",
    await second.client.callTool({ name: "recall", arguments: { query: "vector search database" } }),
  );
  check("forgotten memory no longer recalled", !afterForget.includes("Qdrant"));

  const pid = second.transport.pid;
  await second.client.close();
  await new Promise((resolve) => setTimeout(resolve, 400));
  let alive = false;
  try {
    if (pid) process.kill(pid, 0);
    alive = Boolean(pid);
  } catch {
    alive = false;
  }
  check("server process exited after client close", !alive);

  await verifyRemote(check);

  await rm(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error("verify-mcp failed:", error);
  process.exit(1);
});
