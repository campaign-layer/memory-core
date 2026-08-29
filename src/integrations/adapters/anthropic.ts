import { MEMORY_TOOL_NAMES, dispatch, toAnthropicTools, type MemoryToolContext } from "../tools.js";
import { frameUntrustedMemory } from "./prompt-memory.js";

// Anthropic Messages API wiring: recall before generation, tool-use loop,
// remember after. Structurally typed against @anthropic-ai/sdk so memory-core
// does not depend on it - pass your own `new Anthropic()` instance.

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

export interface AnthropicMessage {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  [key: string]: unknown;
}

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | unknown[];
}

/** Minimal shape of `new Anthropic()` from @anthropic-ai/sdk. */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicMessage>;
  };
}

export interface AnthropicMemoryOptions {
  client: AnthropicLike;
  ctx: MemoryToolContext;
  /** Defaults to claude-opus-5. */
  model?: string;
  maxTokens?: number;
  system?: string;
  /** Extra non-memory tools in Anthropic format. */
  tools?: Array<Record<string, unknown>>;
  toolHandlers?: Record<string, (input: unknown) => Promise<string> | string>;
  /** Inject a build_context block into the system prompt. Default true. */
  injectContext?: boolean;
  contextBudget?: { maxItems?: number; maxChars?: number };
  maxIterations?: number;
}

export interface AnthropicMemoryResult {
  text: string;
  messages: AnthropicMessageParam[];
  memoryCalls: Array<{ name: string; ok: boolean; text: string }>;
  contextInjected: string;
  iterations: number;
}

const MEMORY_TOOL_SET = new Set<string>(MEMORY_TOOL_NAMES);

function textOf(message: AnthropicMessage): string {
  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * One turn with memory attached. Recalls a context block, lets the model use
 * the memory tools, and returns the final text.
 */
export async function runAnthropicTurn(
  userMessage: string,
  options: AnthropicMemoryOptions,
): Promise<AnthropicMemoryResult> {
  const {
    client,
    ctx,
    model = "claude-opus-5",
    maxTokens = 16000,
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

  const messages: AnthropicMessageParam[] = [{ role: "user", content: userMessage }];
  const memoryCalls: AnthropicMemoryResult["memoryCalls"] = [];
  const allTools = [...toAnthropicTools(), ...tools];

  let iterations = 0;
  let text = "";

  while (iterations < maxIterations) {
    iterations += 1;
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      tools: allTools,
      messages,
    });

    text = textOf(response) || text;
    messages.push({ role: "assistant", content: response.content });

    // A server-side tool paused the turn; re-send to resume.
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter(
      (block): block is AnthropicToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) break;

    const results: unknown[] = [];
    for (const toolUse of toolUses) {
      if (MEMORY_TOOL_SET.has(toolUse.name)) {
        const result = await dispatch(toolUse.name, toolUse.input, ctx);
        memoryCalls.push({ name: toolUse.name, ok: result.ok, text: result.text });
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result.text,
          ...(result.ok ? {} : { is_error: true }),
        });
        continue;
      }

      const handler = toolHandlers[toolUse.name];
      if (!handler) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: `No handler registered for tool "${toolUse.name}".`,
          is_error: true,
        });
        continue;
      }
      try {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: await handler(toolUse.input),
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    }

    // All tool results must go back in a single user message.
    messages.push({ role: "user", content: results });
  }

  return { text, messages, memoryCalls, contextInjected, iterations };
}

/**
 * Store a fact after a turn without asking the model to call `remember`.
 * Useful when your app already knows what is worth keeping.
 */
export async function rememberAfterTurn(
  ctx: MemoryToolContext,
  facts: Array<{ text: string; type?: string; importance?: number }>,
): Promise<Array<{ ok: boolean; text: string }>> {
  const out: Array<{ ok: boolean; text: string }> = [];
  for (const fact of facts) {
    const result = await dispatch("remember", fact, ctx);
    out.push({ ok: result.ok, text: result.text });
  }
  return out;
}
