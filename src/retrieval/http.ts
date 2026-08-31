// Minimal JSON POST with exponential backoff. Shared by the hosted embedder
// and reranker adapters so retry behaviour lives in one place.

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Whole-operation deadline across attempts and sleeps, not a per-attempt timeout. */
  timeoutMs?: number;
  /** Upper bound for a server-provided Retry-After delay. Defaults to maxDelayMs. */
  maxRetryAfterMs?: number;
  /** Maximum response body accepted before JSON parsing. Default 1 MiB. */
  maxResponseBytes?: number;
  /** Test/custom transport hook. Must honor standard fetch semantics. */
  fetchImpl?: typeof fetch;
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

export class HttpDeadlineError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`${url} exceeded the ${timeoutMs}ms operation deadline`);
    this.name = "HttpDeadlineError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

function retryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function positiveInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer in 1..${max}`);
  }
  return value;
}

export function retryDelayMs(response: Response, fallbackMs: number, maxRetryAfterMs: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  const requested = Number.isFinite(retryAfter) && retryAfter > 0
    ? retryAfter * 1000
    : fallbackMs;
  return Math.min(requested, maxRetryAfterMs);
}

export async function sleepWithinDeadline(
  delayMs: number,
  deadlineAt: number,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0 || delayMs >= remaining) throw new HttpDeadlineError(url, timeoutMs);
  await sleep(delayMs);
}

export async function fetchWithinDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  deadlineAt: number,
  timeoutMs: number,
): Promise<Response> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new HttpDeadlineError(url, timeoutMs);
  const controller = new AbortController();
  const deadlineError = new HttpDeadlineError(url, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(deadlineError);
      reject(deadlineError);
    }, remaining);
  });
  try {
    return await Promise.race([
      fetchImpl(url, { ...init, redirect: "error", signal: controller.signal }),
      timeout,
    ]);
  } catch (error) {
    if (timedOut) throw deadlineError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function readResponseTextWithinDeadline(
  response: Response,
  maxBytes: number,
  deadlineAt: number,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new HttpDeadlineError(url, timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const deadlineError = new HttpDeadlineError(url, timeoutMs);
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      void response.body?.cancel(deadlineError).catch(() => {});
      reject(deadlineError);
    }, remaining);
  });
  try {
    return await Promise.race([readResponseText(response, maxBytes), timeout]);
  } catch (error) {
    if (timedOut) throw deadlineError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const maxRetryAfterMs = options.maxRetryAfterMs ?? maxDelay;
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "maxResponseBytes",
    16 * 1024 * 1024,
  );
  positiveInteger(timeoutMs, "timeoutMs", 10 * 60_000);
  positiveInteger(maxRetryAfterMs, "maxRetryAfterMs", 10 * 60_000);
  const deadlineAt = Date.now() + timeoutMs;
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoff = (attempt: number) =>
    Math.min(maxDelay, baseDelay * 2 ** attempt) * (0.5 + Math.random());

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetchWithinDeadline(fetchImpl, url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }, deadlineAt, timeoutMs);
    } catch (error) {
      if (error instanceof HttpDeadlineError) throw error;
      // Network / timeout failures are retryable.
      lastError = error;
      if (attempt === maxRetries) throw error;
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
    if (response.ok) return JSON.parse(text) as T;
    const error = new HttpError(response.status, text, url);
    if (!retryable(response.status) || attempt === maxRetries) throw error;

    lastError = error;
    await sleepWithinDeadline(
      retryDelayMs(response, backoff(attempt), maxRetryAfterMs),
      deadlineAt,
      url,
      timeoutMs,
    );
  }

  throw lastError instanceof Error ? lastError : new Error(`${url} failed`);
}
