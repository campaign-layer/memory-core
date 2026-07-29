// Minimal JSON POST with exponential backoff. Shared by the hosted embedder
// and reranker adapters so retry behaviour lives in one place.

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`${url} failed with ${status}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 4;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 8000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const backoff = (attempt: number) =>
    Math.min(maxDelay, baseDelay * 2 ** attempt) * (0.5 + Math.random());

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network / timeout failures are retryable.
      lastError = error;
      if (attempt === maxRetries) throw error;
      await sleep(backoff(attempt));
      continue;
    }

    if (response.ok) return (await response.json()) as T;

    const text = await response.text().catch(() => "");
    const error = new HttpError(response.status, text, url);
    if (!retryable(response.status) || attempt === maxRetries) throw error;

    const retryAfter = Number(response.headers.get("retry-after"));
    lastError = error;
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
    );
  }

  throw lastError instanceof Error ? lastError : new Error(`${url} failed`);
}
