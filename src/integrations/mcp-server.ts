#!/usr/bin/env -S npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemoryCoreClient } from "../client.js";
import { createMemoryProvider, type MemoryProviderKind } from "../providers/factory.js";
import { MemoryCoreService } from "../service.js";
import {
  MEMORY_TOOLS,
  createEmbeddedBackend,
  createRemoteBackend,
  dispatch,
  type MemoryBackend,
  type MemoryIdentity,
  type MemoryToolContext,
} from "./tools.js";

// MCP server over stdio. Tool definitions come from tools.ts - nothing is
// duplicated here. Everything logs to stderr; stdout is the JSON-RPC channel.

const PROVIDER_KINDS = new Set<MemoryProviderKind>(["in-memory", "file", "enhanced", "dual-layer"]);

export type McpMode = "embedded" | "remote";

export interface McpServerConfig {
  mode: McpMode;
  identity: MemoryIdentity;
  sourceType: string;
  /** remote mode */
  baseUrl?: string;
  apiKey?: string;
  /** embedded mode */
  providerKind: MemoryProviderKind;
  filePath?: string;
}

function pick(env: NodeJS.ProcessEnv, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim() !== "") return value.trim();
  }
  return undefined;
}

const CONFIG_HELP = `memory-core MCP server requires identity env vars:
  MEMORY_TENANT_ID   tenant that owns the memories (required)
  MEMORY_SPACE_ID    stable personal/workspace memory space (default: actor id)
  MEMORY_APP_ID      app / product writing the memories (required)
  MEMORY_ACTOR_ID    the end user or agent the memories belong to (required)
  MEMORY_THREAD_ID   optional conversation id
Mode:
  MEMORY_CORE_URL    set this to proxy a running memory-core service (remote mode)
  MEMORY_CORE_API_KEY  api key for that service, if it enforces one
  MEMORY_CORE_MODE   force "embedded" or "remote"
Embedded storage:
  MEMORY_PROVIDER    in-memory | file | enhanced | dual-layer (default: file)
  MEMORY_FILE_PATH   where the file provider persists (default: ./data/memory-core.json)`;

export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpServerConfig {
  const tenantId = pick(env, "MEMORY_TENANT_ID", "MEMORY_CORE_TENANT_ID");
  const appId = pick(env, "MEMORY_APP_ID", "MEMORY_CORE_APP_ID");
  const actorId = pick(env, "MEMORY_ACTOR_ID", "MEMORY_CORE_ACTOR_ID");

  const missing = [
    ["MEMORY_TENANT_ID", tenantId],
    ["MEMORY_APP_ID", appId],
    ["MEMORY_ACTOR_ID", actorId],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(", ")}\n\n${CONFIG_HELP}`);
  }

  const baseUrl = pick(env, "MEMORY_CORE_URL", "MEMORY_CORE_BASE_URL");
  const forced = pick(env, "MEMORY_CORE_MODE");
  if (forced && forced !== "embedded" && forced !== "remote") {
    throw new Error(`Invalid MEMORY_CORE_MODE "${forced}". Use "embedded" or "remote".`);
  }
  const mode: McpMode = forced ? (forced as McpMode) : baseUrl ? "remote" : "embedded";
  if (mode === "remote" && !baseUrl) {
    throw new Error("MEMORY_CORE_MODE=remote requires MEMORY_CORE_URL.");
  }

  const providerRaw = pick(env, "MEMORY_PROVIDER") ?? "file";
  if (!PROVIDER_KINDS.has(providerRaw as MemoryProviderKind)) {
    throw new Error(
      `Invalid MEMORY_PROVIDER "${providerRaw}". Use one of: ${[...PROVIDER_KINDS].join(", ")}.`,
    );
  }

  return {
    mode,
    identity: {
      tenantId: tenantId!,
      spaceId: pick(env, "MEMORY_SPACE_ID", "MEMORY_CORE_SPACE_ID"),
      appId: appId!,
      actorId: actorId!,
      threadId: pick(env, "MEMORY_THREAD_ID", "MEMORY_CORE_THREAD_ID"),
    },
    sourceType: pick(env, "MEMORY_SOURCE_TYPE") ?? "mcp",
    baseUrl,
    apiKey: pick(env, "MEMORY_CORE_API_KEY"),
    providerKind: providerRaw as MemoryProviderKind,
    filePath: pick(env, "MEMORY_FILE_PATH") ?? "./data/memory-core.json",
  };
}

export function createBackendFromConfig(config: McpServerConfig): MemoryBackend {
  if (config.mode === "remote") {
    return createRemoteBackend(
      new MemoryCoreClient({ baseUrl: config.baseUrl!, apiKey: config.apiKey }),
    );
  }
  const provider = createMemoryProvider({
    kind: config.providerKind,
    filePath: config.filePath,
  });
  // Provider is passed so forget/supersede can actually retire records.
  return createEmbeddedBackend(new MemoryCoreService(provider), provider);
}

export function createMemoryMcpServer(ctx: MemoryToolContext): McpServer {
  const server = new McpServer(
    { name: "memory-core", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  for (const tool of MEMORY_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.name === "forget" || tool.name === "supersede",
          idempotentHint: tool.name !== "feedback",
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        try {
          const result = await dispatch(tool.name, args, ctx);
          return {
            content: [{ type: "text" as const, text: result.text }],
            isError: !result.ok,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text" as const, text: `memory-core ${tool.name} failed: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadMcpConfig(env);
  const backend = createBackendFromConfig(config);

  const server = createMemoryMcpServer({
    backend,
    identity: config.identity,
    sourceType: config.sourceType,
    metadata: { channel: "mcp" },
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const target =
    config.mode === "remote" ? config.baseUrl : `${config.providerKind}:${config.filePath}`;
  process.stderr.write(
    `[memory-core-mcp] ready mode=${config.mode} target=${target} tenant=${config.identity.tenantId} app=${config.identity.appId} actor=${config.identity.actorId} tools=${MEMORY_TOOLS.length}\n`,
  );

  let closing = false;
  const CLOSE_TIMEOUT_MS = 5_000;
  const closeWithin = async (label: string, close: () => void | Promise<void>) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(close),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} exceeded ${CLOSE_TIMEOUT_MS}ms`)),
            CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[memory-core-mcp] ${signal} received, closing\n`);
    let exitCode = 0;
    if (signal !== "transport close") {
      try {
        await closeWithin("MCP server close", () => server.close());
      } catch (error) {
        exitCode = 1;
        process.stderr.write(
          `[memory-core-mcp] server close failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    try {
      if (backend.close) await closeWithin("provider close", () => backend.close!());
    } catch (error) {
      exitCode = 1;
      process.stderr.write(
        `[memory-core-mcp] provider close failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    process.exit(exitCode);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  // Client closed stdin: nothing more will arrive.
  transport.onclose = () => void shutdown("transport close");
}

const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error: unknown) => {
    process.stderr.write(`[memory-core-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
