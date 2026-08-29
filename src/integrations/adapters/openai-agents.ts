import { z } from "zod";
import {
  MEMORY_TOOLS,
  MEMORY_TOOL_NAMES,
  dispatch,
  shapeToJsonSchema,
  toOpenAITools,
  type JsonSchemaNode,
  type MemoryToolContext,
} from "../tools.js";
import { frameUntrustedMemory } from "./prompt-memory.js";

// OpenAI-compatible wiring. Structurally typed against the `openai` package so
// memory-core does not depend on it - pass your own `new OpenAI()` instance.
// Works with any OpenAI-compatible endpoint (Groq, Together, vLLM, Ollama, ...).

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIAssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIChoice {
  message: OpenAIAssistantMessage;
  finish_reason: string | null;
}

export interface OpenAICompletion {
  choices: OpenAIChoice[];
}

/** Minimal shape of `new OpenAI()` from the openai package. */
export interface OpenAILike {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<OpenAICompletion>;
    };
  };
}

export interface OpenAIMemoryOptions {
  client: OpenAILike;
  ctx: MemoryToolContext;
  model?: string;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  toolHandlers?: Record<string, (args: unknown) => Promise<string> | string>;
  injectContext?: boolean;
  contextBudget?: { maxItems?: number; maxChars?: number };
  maxIterations?: number;
}

export interface OpenAIMemoryResult {
  text: string;
  messages: Array<Record<string, unknown>>;
  memoryCalls: Array<{ name: string; ok: boolean; text: string }>;
  contextInjected: string;
  iterations: number;
}

const MEMORY_TOOL_SET = new Set<string>(MEMORY_TOOL_NAMES);

function parseArguments(raw: string): unknown {
  if (!raw || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Surface as a validation failure instead of throwing out of the loop.
    return { __unparsable: raw };
  }
}

export async function runOpenAITurn(
  userMessage: string,
  options: OpenAIMemoryOptions,
): Promise<OpenAIMemoryResult> {
  const {
    client,
    ctx,
    model = "gpt-4.1",
    tools = [],
    toolHandlers = {},
    injectContext = true,
    maxIterations = 12,
  } = options;

  let contextInjected = "";
  if (injectContext) {
    const context = await dispatch(
      "build_context",
      { query: userMessage, ...(options.contextBudget ?? {}) },
      ctx,
    );
    if (context.ok) contextInjected = context.text;
  }

  const systemParts = [
    options.system,
    contextInjected ? frameUntrustedMemory(contextInjected) : "",
  ]
    .filter((part): part is string => Boolean(part && part.trim()));

  const messages: Array<Record<string, unknown>> = [];
  if (systemParts.length > 0) messages.push({ role: "system", content: systemParts.join("\n\n") });
  messages.push({ role: "user", content: userMessage });

  const memoryCalls: OpenAIMemoryResult["memoryCalls"] = [];
  const allTools = [...toOpenAITools(), ...tools];

  let iterations = 0;
  let text = "";

  while (iterations < maxIterations) {
    iterations += 1;
    const completion = await client.chat.completions.create({
      model,
      tools: allTools,
      messages,
    });

    const choice = completion.choices[0];
    if (!choice) break;

    const message = choice.message;
    text = message.content ?? text;
    messages.push({
      role: "assistant",
      content: message.content,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    });

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) break;

    for (const call of toolCalls) {
      const args = parseArguments(call.function.arguments);

      if (MEMORY_TOOL_SET.has(call.function.name)) {
        const result = await dispatch(call.function.name, args, ctx);
        memoryCalls.push({ name: call.function.name, ok: result.ok, text: result.text });
        messages.push({ role: "tool", tool_call_id: call.id, content: result.text });
        continue;
      }

      const handler = toolHandlers[call.function.name];
      if (!handler) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `No handler registered for tool "${call.function.name}".`,
        });
        continue;
      }
      try {
        messages.push({ role: "tool", tool_call_id: call.id, content: await handler(args) });
      } catch (error) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { text, messages, memoryCalls, contextInjected, iterations };
}

export interface AgentsSdkTool {
  name: string;
  description: string;
  /** JSON Schema; the Agents SDK also accepts a zod schema - see `zodParameters`. */
  parameters: JsonSchemaNode;
  zodParameters: z.ZodObject<z.ZodRawShape>;
  strict: false;
  execute(args: unknown): Promise<string>;
}

/**
 * Tool descriptors for the OpenAI Agents SDK (`@openai/agents`), which is not a
 * dependency here. Spread each entry into that package's `tool({...})` helper -
 * verify the field names against your installed version, they are not checked
 * at build time.
 */
export function toOpenAIAgentsTools(ctx: MemoryToolContext): AgentsSdkTool[] {
  return MEMORY_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: shapeToJsonSchema(tool.shape),
    zodParameters: tool.schema as z.ZodObject<z.ZodRawShape>,
    strict: false as const,
    execute: async (args: unknown) => (await dispatch(tool.name, args, ctx)).text,
  }));
}
