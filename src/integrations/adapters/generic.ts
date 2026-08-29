import {
  MEMORY_TOOLS,
  dispatch,
  shapeToJsonSchema,
  toAnthropicTools,
  toJsonSchema,
  toOpenAITools,
  type JsonSchemaNode,
  type MemoryToolContext,
  type MemoryToolResult,
} from "../tools.js";
import { frameUntrustedMemory } from "./prompt-memory.js";

// Framework-agnostic toolkit. Any agent runtime that can (a) list tools with a
// JSON Schema and (b) call one by name can be wired up with this.

export interface GenericToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
  readOnly: boolean;
  /** Validates and executes. Never throws on bad model input. */
  invoke(args: unknown): Promise<MemoryToolResult>;
}

export interface MemoryToolkit {
  tools: GenericToolSpec[];
  /** Same tools in the shapes the major APIs expect. */
  anthropic: ReturnType<typeof toAnthropicTools>;
  openai: ReturnType<typeof toOpenAITools>;
  jsonSchema: ReturnType<typeof toJsonSchema>;
  /** Call a tool by name; unknown names come back as ok:false. */
  call(name: string, args: unknown): Promise<MemoryToolResult>;
  /** Memory block to prepend to a system prompt before generating. */
  preamble(query: string, budget?: { maxItems?: number; maxChars?: number }): Promise<string>;
  /** Store a durable fact after a turn. */
  capture(
    text: string,
    options?: { type?: string; importance?: number; scope?: string },
  ): Promise<MemoryToolResult>;
}

export function createMemoryToolkit(ctx: MemoryToolContext): MemoryToolkit {
  const call = (name: string, args: unknown) => dispatch(name, args, ctx);

  return {
    tools: MEMORY_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: shapeToJsonSchema(tool.shape),
      readOnly: tool.readOnly,
      invoke: (args: unknown) => call(tool.name, args),
    })),
    anthropic: toAnthropicTools(),
    openai: toOpenAITools(),
    jsonSchema: toJsonSchema(),
    call,
    async preamble(query, budget) {
      const result = await call("build_context", {
        query,
        ...(budget?.maxItems ? { maxItems: budget.maxItems } : {}),
        ...(budget?.maxChars ? { maxChars: budget.maxChars } : {}),
      });
      return result.ok ? frameUntrustedMemory(result.text) : "";
    },
    capture(text, options) {
      return call("remember", { text, ...(options ?? {}) });
    },
  };
}

/** Text form of the tool list, for runtimes that only accept a prompt. */
export function describeMemoryTools(): string {
  return MEMORY_TOOLS.map((tool) => {
    const schema = shapeToJsonSchema(tool.shape);
    const params = Object.entries(schema.properties ?? {})
      .map(([key, prop]) => {
        const required = (schema.required ?? []).includes(key);
        return `${key}${required ? "" : "?"}: ${prop.enum ? prop.enum.join("|") : prop.type}`;
      })
      .join(", ");
    return `${tool.name}(${params})\n  ${tool.description}`;
  }).join("\n\n");
}
