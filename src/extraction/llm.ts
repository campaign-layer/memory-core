// Minimal OpenAI-compatible /chat/completions client.
//
// It does NOT reuse retrieval/http.ts postJson() for one reason: postJson calls
// response.json(), and OpenRouter prepends keep-alive padding (blank lines and
// `: OPENROUTER PROCESSING` comment lines) to a non-streamed body, which makes
// the strict parser throw on an otherwise fine response. Retry/backoff semantics
// are copied from that module deliberately so both behave the same on 429/5xx.

// HttpError is intentionally NOT re-exported: src/index.ts star-exports both this
// module and retrieval/index.js, and a duplicated name there is an ambiguous
// star export. Import it from ./retrieval/http.js.
import {
  fetchWithinDeadline,
  HttpDeadlineError,
  HttpError,
  readResponseTextWithinDeadline,
  retryDelayMs,
  sleepWithinDeadline,
  type RetryOptions,
} from "../retrieval/http.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the endpoint for a JSON object body (response_format). */
  json?: boolean;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatCompletion {
  content: string;
  usage?: ChatUsage;
  model?: string;
}

export interface ChatClient {
  readonly id: string;
  complete(request: ChatCompletionRequest): Promise<ChatCompletion>;
}

/**
 * Raised when a completion comes back with no usable text. Reasoning models do
 * this for real: `message.content` is null and the text sits in `reasoning` /
 * `reasoning_content`. We recover from those fields, and only throw when there
 * is genuinely nothing — an empty string must never be scored as a success.
 */
export class EmptyCompletionError extends Error {
  constructor(model: string, readonly finishReason?: string) {
    super(`${model} returned an empty completion${finishReason ? ` (finish_reason=${finishReason})` : ""}`);
    this.name = "EmptyCompletionError";
  }
}

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Tolerant JSON body parse. Skips whatever precedes the first `{`/`[` so
 * keep-alive padding, SSE comment lines and stray prose cannot fail the call.
 */
export function parseJsonBody<T>(raw: string, url: string): T {
  const start = raw.search(/[{[]/);
  if (start < 0) {
    throw new Error(`${url} returned a non-JSON body: ${raw.slice(0, 200)}`);
  }
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch (cause) {
    throw new Error(`${url} returned malformed JSON: ${raw.slice(start, start + 200)}`, { cause });
  }
}

interface RawChoice {
  message?: {
    content?: string | null | Array<{ type?: string; text?: string }>;
    reasoning?: string | null;
    reasoning_content?: string | null;
  };
  text?: string | null;
  finish_reason?: string | null;
}

interface RawCompletion {
  choices?: RawChoice[];
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Pulls text out of a choice, including the reasoning-model shapes. */
export function readChoiceText(choice: RawChoice | undefined): string {
  if (!choice) return "";
  const message = choice.message;
  const content = message?.content;

  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (joined) return joined;
  }
  // Reasoning models: content is null, the answer rode along in the trace.
  for (const candidate of [message?.reasoning_content, message?.reasoning, choice.text]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return "";
}

export interface OpenAiChatClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  retry?: RetryOptions;
  headers?: Record<string, string>;
  temperature?: number;
  maxTokens?: number;
  /** Retries that produced no text before giving up. */
  maxEmptyRetries?: number;
}

export interface ChatClientStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  emptyCompletions: number;
  retries: number;
}

/**
 * OpenAI-compatible chat client: OpenAI, OpenRouter, Together, Groq, vLLM and
 * llama.cpp all speak this surface. The API key is optional so a local endpoint
 * needs no credentials.
 */
export class OpenAiChatClient implements ChatClient {
  readonly id: string;
  readonly stats: ChatClientStats = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    emptyCompletions: 0,
    retries: 0,
  };

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly retry: RetryOptions;
  private readonly headers: Record<string, string>;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly maxEmptyRetries: number;
  /** Flipped when an endpoint rejects response_format, so we stop sending it. */
  private jsonModeSupported = true;

  constructor(options: OpenAiChatClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.MEMORY_EXTRACTOR_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? process.env.MEMORY_EXTRACTOR_API_KEY ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? "gpt-4o-mini";
    this.retry = options.retry ?? {};
    this.headers = options.headers ?? {};
    this.temperature = options.temperature ?? 0;
    this.maxTokens = options.maxTokens ?? 2048;
    this.maxEmptyRetries = options.maxEmptyRetries ?? 2;
    this.id = `openai-chat:${this.model}`;
  }

  async complete(request: ChatCompletionRequest): Promise<ChatCompletion> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxEmptyRetries; attempt++) {
      const body: Record<string, unknown> = {
        model: this.model,
        messages: request.messages,
        // A repeat of an empty response needs a nudge off the same sampling path.
        temperature: attempt === 0 ? (request.temperature ?? this.temperature) : 0.3,
        max_tokens: request.maxTokens ?? this.maxTokens,
      };
      if (request.json && this.jsonModeSupported) {
        body.response_format = { type: "json_object" };
      }

      const raw = await this.post(body);
      this.stats.calls += 1;
      if (raw.usage) {
        this.stats.promptTokens += raw.usage.prompt_tokens ?? 0;
        this.stats.completionTokens += raw.usage.completion_tokens ?? 0;
      }
      if (raw.error?.message) throw new Error(`${this.id} error: ${raw.error.message}`);

      const choice = raw.choices?.[0];
      const content = readChoiceText(choice);
      if (content) {
        return {
          content,
          model: raw.model,
          usage: raw.usage
            ? {
                promptTokens: raw.usage.prompt_tokens ?? 0,
                completionTokens: raw.usage.completion_tokens ?? 0,
              }
            : undefined,
        };
      }

      this.stats.emptyCompletions += 1;
      lastError = new EmptyCompletionError(this.model, choice?.finish_reason ?? undefined);
      if (attempt < this.maxEmptyRetries) this.stats.retries += 1;
    }

    throw lastError instanceof Error ? lastError : new EmptyCompletionError(this.model);
  }

  private async post(body: Record<string, unknown>): Promise<RawCompletion> {
    const url = `${this.baseUrl}/chat/completions`;
    const maxRetries = this.retry.maxRetries ?? 4;
    const baseDelay = this.retry.baseDelayMs ?? 500;
    const maxDelay = this.retry.maxDelayMs ?? 8000;
    const timeoutMs = this.retry.timeoutMs ?? 120_000;
    const maxRetryAfterMs = this.retry.maxRetryAfterMs ?? maxDelay;
    const maxResponseBytes = this.retry.maxResponseBytes ?? 1024 * 1024;
    const deadlineAt = Date.now() + timeoutMs;
    const fetchImpl = this.retry.fetchImpl ?? fetch;
    const backoff = (attempt: number) => Math.min(maxDelay, baseDelay * 2 ** attempt) * (0.5 + Math.random());

    const headers: Record<string, string> = { "content-type": "application/json", ...this.headers };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response;
      try {
        response = await fetchWithinDeadline(fetchImpl, url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }, deadlineAt, timeoutMs);
      } catch (error) {
        if (error instanceof HttpDeadlineError) throw error;
        lastError = error;
        if (attempt === maxRetries) throw error;
        this.stats.retries += 1;
        await sleepWithinDeadline(backoff(attempt), deadlineAt, url, timeoutMs);
        continue;
      }

      const text = await readResponseTextWithinDeadline(
        response,
        maxResponseBytes,
        deadlineAt,
        url,
        timeoutMs,
      );
      if (response.ok) return parseJsonBody<RawCompletion>(text, url);

      // Endpoints that do not implement JSON mode reject the whole request.
      if (response.status === 400 && "response_format" in body && /response_format|json_object|json mode/i.test(text)) {
        this.jsonModeSupported = false;
        delete body.response_format;
        continue;
      }

      const error = new HttpError(response.status, text, url);
      if (!retryable(response.status) || attempt === maxRetries) throw error;

      lastError = error;
      this.stats.retries += 1;
      await sleepWithinDeadline(
        retryDelayMs(response, backoff(attempt), maxRetryAfterMs),
        deadlineAt,
        url,
        timeoutMs,
      );
    }

    throw lastError instanceof Error ? lastError : new Error(`${url} failed`);
  }
}
