export * from "./tools.js";
export * from "./adapters/generic.js";
export {
  runAnthropicTurn,
  rememberAfterTurn,
  type AnthropicLike,
  type AnthropicMemoryOptions,
  type AnthropicMemoryResult,
} from "./adapters/anthropic.js";
export {
  runOpenAITurn,
  toOpenAIAgentsTools,
  type OpenAILike,
  type OpenAIMemoryOptions,
  type OpenAIMemoryResult,
  type AgentsSdkTool,
} from "./adapters/openai-agents.js";
export {
  openClawMcpConfig,
  memoryCoreOpenClawTools,
  openClawPluginManifest,
  type OpenClawMcpConfig,
  type OpenClawMcpOptions,
  type OpenClawToolDescriptor,
} from "./adapters/openclaw.js";
export {
  hermesMcpConfig,
  hermesMcpConfigYaml,
  hermesToolSchemas,
  type HermesMcpOptions,
  type HermesToolSchema,
} from "./adapters/hermes.js";

// The MCP server is deliberately not re-exported: importing it pulls in the
// full @modelcontextprotocol/sdk server stack. Import it directly instead:
//   import { createMemoryMcpServer } from "@maitrix/memory-core/integrations/mcp-server.js";
