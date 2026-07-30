/**
 * Minimal OpenRouter chat client.
 *
 * Two things this must get right:
 *  1. OpenRouter emits keep-alive blank lines / ": OPENROUTER PROCESSING" comments
 *     before the JSON body, so the body is trimmed and scanned for the first '{'
 *     before parsing. Parsing raw text here produces spurious failures.
 *  2. Retry on 429/5xx/network with exponential backoff + jitter, and respect
 *     Retry-After when the server sends one.
 */
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Environment only. Nothing in this harness reads a key off disk. */
export function loadApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set.\n" +
        "Mode B calls a reader and a judge model over OpenRouter, so it needs a key:\n" +
        "  export OPENROUTER_API_KEY=...\n" +
        "Mode A (retrieval only) needs no key at all.",
    );
  }
  return key;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** OpenRouter's own billed cost in USD when it reports one. */
  costUsd: number | null;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage;
  attempts: number;
  /** Upstream OpenRouter routed to. Recorded because routing varies per call. */
  provider: string | null;
  finishReason: string | null;
  /** True when content was empty and the answer came out of the reasoning trace. */
  fromReasoning: boolean;
}

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  maxAttempts?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Strips keep-alive padding, then parses from the first brace. */
function parseBody(body: string): any {
  const trimmed = body.replace(/^(?:\s*(?::[^\n]*)?\n)+/g, "").trim();
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error(`no JSON object in response body: ${body.slice(0, 200)}`);
  return JSON.parse(trimmed.slice(start));
}

export async function chat(apiKey: string, opts: ChatOptions): Promise<ChatResult> {
  const maxAttempts = opts.maxAttempts ?? 6;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 180_000);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "memory-core-longmemeval",
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
          max_tokens: opts.maxTokens ?? 256,
          temperature: opts.temperature ?? 0,
          // Asks OpenRouter to return real accounting, including billed cost.
          usage: { include: true },
        }),
      });

      const body = await res.text();

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(60_000, 1000 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6);
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        if (attempt < maxAttempts) { await sleep(wait); continue; }
        throw lastErr;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);

      const json = parseBody(body);
      if (json.error) throw new Error(`provider error: ${JSON.stringify(json.error).slice(0, 300)}`);

      const choice = json.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const finishReason: string | null = choice.finish_reason ?? null;
      const providerName: string | null = json.provider ?? null;

      let text = typeof msg.content === "string" ? msg.content.trim() : "";
      let fromReasoning = false;

      // OpenRouter fans out to several upstreams for this model and some of them
      // spend the whole budget on a reasoning trace, leaving content empty. Recover
      // the answer from the trace rather than discarding the (already paid for) call.
      if (!text) {
        const trace: string = typeof msg.reasoning === "string" ? msg.reasoning
          : typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
        const tail = trace.split("\n").map((l) => l.trim()).filter(Boolean).pop();
        if (tail) { text = tail; fromReasoning = true; }
      }

      // Empty content is usually the upstream's fault, and a retry re-rolls routing.
      if (!text && attempt < maxAttempts) {
        lastErr = new Error(`empty content (finish_reason=${finishReason}, provider=${providerName})`);
        await sleep(500 * attempt);
        continue;
      }
      if (!text) throw new Error(`no message content after ${attempt} attempts (finish_reason=${finishReason}, provider=${providerName})`);

      const u = json.usage ?? {};
      return {
        text,
        usage: {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
          costUsd: typeof u.cost === "number" ? u.cost : null,
        },
        attempts: attempt,
        provider: providerName,
        finishReason,
        fromReasoning,
      };
    } catch (err: any) {
      lastErr = err;
      const retryable = err?.name === "AbortError" || /fetch failed|ECONN|ETIMEDOUT|socket hang up|HTTP 5|HTTP 429/i.test(String(err?.message ?? err));
      if (attempt < maxAttempts && retryable) {
        await sleep(Math.min(60_000, 1000 * 2 ** (attempt - 1)) * (0.7 + Math.random() * 0.6));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Bounded-concurrency map that preserves nothing but does not lose failures. */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}
