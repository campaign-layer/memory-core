import { MEMORY_TOOLS, shapeToJsonSchema, type JsonSchemaNode } from "../tools.js";

// Hermes Agent (github.com/NousResearch/hermes-agent) - Python 3.11-3.13 agent.
//
// Two integration paths:
//   1. MCP - verified. Emit the `mcp_servers` block for ~/.hermes/config.yaml
//      with hermesMcpConfigYaml(). Hermes exposes each tool as
//      `mcp_<server>_<tool>`, e.g. mcp_memory_core_recall.
//   2. Native Python plugin at ~/.hermes/plugins/memory-core/ - see
//      ./hermes-plugin/ in this repo. Its schemas.json is generated from
//      hermesToolSchemas() below, so zod stays the single source of truth.
//
// Not implemented: Hermes' MemoryProvider ABC (agent/memory_provider.py), which
// is the deeper "become the memory backend" integration. It is documented but
// only one external memory provider can be active at a time, so it is a product
// decision rather than an additive adapter. See README for what it would need.
//
// Distinct from the Nous Hermes *models* (Hermes 2/3/4), which are weights with
// a <tool_call> prompt convention and no plugin surface - for those, use
// toOpenAITools() from ../tools.ts with whatever host serves them.

export interface HermesToolSchema {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
}

/** OpenAI-style function schemas, the form Hermes' ctx.register_tool(schema=) takes. */
export function hermesToolSchemas(): HermesToolSchema[] {
  return MEMORY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: shapeToJsonSchema(tool.shape),
  }));
}

export interface HermesMcpOptions {
  /** Server name; tools become mcp_<name>_<tool>. Use snake_case. */
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  identity: { tenantId: string; spaceId?: string; appId: string; actorId: string; threadId?: string };
  memoryCoreUrl?: string;
  apiKey?: string;
  provider?: "in-memory" | "file" | "enhanced" | "dual-layer";
  filePath?: string;
}

export interface HermesMcpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  supports_parallel_tool_calls: boolean;
  tools: { include: string[]; prompts: boolean; resources: boolean };
}

export function hermesMcpConfig(options: HermesMcpOptions): {
  mcp_servers: Record<string, HermesMcpServerEntry>;
} {
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
    mcp_servers: {
      [options.name ?? "memory_core"]: {
        command: options.command ?? "npx",
        args: options.args ?? ["tsx", "src/integrations/mcp-server.ts"],
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env,
        supports_parallel_tool_calls: true,
        tools: {
          include: MEMORY_TOOLS.map((tool) => tool.name),
          prompts: false,
          resources: false,
        },
      },
    },
  };
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value !== "string") return String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Ready-to-paste fragment for ~/.hermes/config.yaml. */
export function hermesMcpConfigYaml(options: HermesMcpOptions): string {
  const config = hermesMcpConfig(options);
  const [name, entry] = Object.entries(config.mcp_servers)[0]!;
  const lines = ["mcp_servers:", `  ${name}:`];

  lines.push(`    command: ${yamlScalar(entry.command)}`);
  lines.push(`    args: [${entry.args.map((arg) => yamlScalar(arg)).join(", ")}]`);
  if (entry.cwd) lines.push(`    cwd: ${yamlScalar(entry.cwd)}`);
  lines.push("    env:");
  for (const [key, value] of Object.entries(entry.env)) {
    lines.push(`      ${key}: ${yamlScalar(value)}`);
  }
  lines.push(`    supports_parallel_tool_calls: ${entry.supports_parallel_tool_calls}`);
  lines.push("    tools:");
  lines.push(`      include: [${entry.tools.include.join(", ")}]`);
  lines.push("      prompts: false");
  lines.push("      resources: false");
  return lines.join("\n");
}
