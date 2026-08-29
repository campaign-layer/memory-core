import {
  MEMORY_TOOLS,
  dispatch,
  shapeToJsonSchema,
  type JsonSchemaNode,
  type MemoryToolContext,
} from "../tools.js";

// OpenClaw (github.com/openclaw/openclaw) - TypeScript AI agent gateway.
//
// Two integration paths, in order of confidence:
//   1. MCP  - fully verified. Use openClawMcpConfig() below and `openclaw mcp set`.
//   2. Tool plugin - shapes below follow docs/plugins/tool-plugins.md, but
//      `openclaw` and `typebox` are not dependencies here, so nothing is
//      checked at build time. Validate with `openclaw plugins validate`.
//
// NOT implemented: OpenClaw's native memory slot (api.registerMemoryCapability).
// That is an exclusive slot whose MemoryCapability interface is not published in
// the docs - it lives in the OpenClaw source. Read that type before attempting it.
//
// Naming note: OpenClaw ships its own bundled plugin called `memory-core`.
// Use a distinct plugin id (default below: `maitrix-memory-core`).

export interface OpenClawMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: "streamable-http";
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  enabled?: boolean;
  toolFilter?: { include?: string[]; exclude?: string[] };
}

export interface OpenClawMcpConfig {
  mcp: { servers: Record<string, OpenClawMcpServerEntry> };
}

export interface OpenClawMcpOptions {
  /** Server key under mcp.servers. */
  name?: string;
  command?: string;
  args?: string[];
  /** tenant/app/actor are required by memory-core and passed as env. */
  identity: { tenantId: string; spaceId?: string; appId: string; actorId: string; threadId?: string };
  /** Set to proxy an existing memory-core HTTP service instead of embedding. */
  memoryCoreUrl?: string;
  apiKey?: string;
  provider?: "in-memory" | "file" | "enhanced" | "dual-layer";
  filePath?: string;
}

/**
 * Config fragment for ~/.openclaw/openclaw.json. Note the key is `mcp.servers`,
 * not the `mcpServers` used by Claude Desktop / Claude Code.
 */
export function openClawMcpConfig(options: OpenClawMcpOptions): OpenClawMcpConfig {
  const env: Record<string, string> = {
    MEMORY_TENANT_ID: options.identity.tenantId,
    MEMORY_APP_ID: options.identity.appId,
    MEMORY_ACTOR_ID: options.identity.actorId,
  };
  if (options.identity.spaceId) env.MEMORY_SPACE_ID = options.identity.spaceId;
  if (options.identity.threadId) env.MEMORY_THREAD_ID = options.identity.threadId;
  if (options.memoryCoreUrl) env.MEMORY_CORE_URL = options.memoryCoreUrl;
  if (options.apiKey) env.MEMORY_CORE_API_KEY = options.apiKey;
  if (options.provider) env.MEMORY_PROVIDER = options.provider;
  if (options.filePath) env.MEMORY_FILE_PATH = options.filePath;

  return {
    mcp: {
      servers: {
        [options.name ?? "maitrix-memory-core"]: {
          command: options.command ?? "npx",
          args: options.args ?? ["tsx", "src/integrations/mcp-server.ts"],
          env,
          supportsParallelToolCalls: true,
          toolFilter: { include: MEMORY_TOOLS.map((tool) => tool.name) },
        },
      },
    },
  };
}

/** Shape OpenClaw's `tool(...)` factory accepts inside `defineToolPlugin({ tools })`. */
export interface OpenClawToolDescriptor {
  name: string;
  label: string;
  description: string;
  /**
   * JSON Schema. OpenClaw's docs build this with typebox `Type.Object(...)`,
   * whose runtime value is a plain JSON Schema object - so this is expected to
   * be accepted directly, but that is unverified here.
   */
  parameters: JsonSchemaNode;
  execute(args: unknown, config: unknown, context?: { signal?: AbortSignal }): Promise<string>;
}

/**
 * Tool descriptors to spread into OpenClaw's `tool(...)` factory:
 *
 *   export default defineToolPlugin({
 *     id: "maitrix-memory-core",
 *     name: "Maitrix Memory Core",
 *     description: "Long-term memory for agents.",
 *     tools: (tool) => memoryCoreOpenClawTools(ctx).map((spec) => tool(spec)),
 *   });
 */
export function memoryCoreOpenClawTools(ctx: MemoryToolContext): OpenClawToolDescriptor[] {
  return MEMORY_TOOLS.map((tool) => ({
    name: tool.name,
    label: tool.title,
    description: tool.description,
    parameters: shapeToJsonSchema(tool.shape),
    async execute(args: unknown, _config: unknown, context?: { signal?: AbortSignal }) {
      context?.signal?.throwIfAborted();
      const result = await dispatch(tool.name, args, ctx);
      return result.text;
    },
  }));
}

/** Manifest fragment for openclaw.plugin.json. `contracts.tools` drives discovery. */
export function openClawPluginManifest(id = "maitrix-memory-core") {
  return {
    id,
    name: "Maitrix Memory Core",
    description: "Durable cross-session memory: remember, recall, and correct facts.",
    version: "0.1.0",
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    activation: { onStartup: true },
    contracts: { tools: MEMORY_TOOLS.map((tool) => tool.name) },
  };
}
