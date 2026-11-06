/**
 * The shared HTTP layer for every LLM provider — Phase E1.
 *
 * All four things the task book asks for live here, once, instead of being
 * re-implemented (slightly differently) in three providers:
 *
 * 1. **A single error model** — every failure leaves this module as an
 *    `LLMError` with one of the seven codes.
 * 2. **A single timeout policy** — one deadline covers the connect, the
 *    response headers *and* the body, so a server that sends headers and
 *    then stalls cannot hang the app forever.
 * 3. **Cancellation** — the caller's `AbortSignal` is honoured, and it is
 *    told apart from a timeout (`ABORTED` vs `TIMEOUT_ERROR`).
 * 4. **Bounded backoff** — retryable failures are retried a limited number
 *    of times with an exponential delay, and `Retry-After` is honoured when
 *    the provider sends one.
 *
 * See `docs/修复.md` § 八 E1 and `packages/llm/src/errors.ts` for the
 * reasoning behind *which* failures are retryable.
 */

import { LLMError, redactSecrets } from './errors';

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/** Default request deadline: one minute. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default number of *additional* attempts after a retryable failure.
 *
 * Two retries means at most three requests — enough to ride out a 429 or a
 * single 502, not enough to turn one broken call into a burst.
 */
export const DEFAULT_MAX_RETRIES = 2;

/** First backoff delay; each retry doubles it. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** Ceiling for the exponential backoff (a `Retry-After` may exceed it). */
export const DEFAULT_RETRY_MAX_DELAY_MS = 8_000;

/**
 * Hard ceiling on how long we are willing to sit on a `Retry-After`.
 *
 * The provider may ask for anything; the user is watching a spinner, so we
 * cap the wait and then try anyway rather than freezing the screen.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/**
 * How a provider makes one request: deadlines, retries and the two
 * injectable seams (`fetchImpl`, `sleep`).
 *
 * The two seams exist so the test suite can drive timeouts and backoff
 * without waiting in real time. The defaults are the ones production uses.
 */
export interface RequestPolicy {
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fetchImpl: typeof fetch;
}

/**
 * The knobs a caller may set on a provider (or on a single call).
 *
 * `sleep` and `fetchImpl` are test seams; production never sets them.
 */
export interface LLMRequestOptions {
  /** Deadline for one attempt, in milliseconds. Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Extra attempts after a retryable failure. Default {@link DEFAULT_MAX_RETRIES}. */
  readonly maxRetries?: number;
  /** First backoff delay in milliseconds. Default {@link DEFAULT_RETRY_BASE_DELAY_MS}. */
  readonly retryBaseDelayMs?: number;
  /** Ceiling for the exponential backoff. Default {@link DEFAULT_RETRY_MAX_DELAY_MS}. */
  readonly retryMaxDelayMs?: number;
  /** Injected in tests to make backoff instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests. Defaults to `globalThis.fetch`, looked up per call. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The default policy.
 *
 * `fetchImpl` calls `globalThis.fetch` **at call time** on purpose: the test
 * suite replaces `globalThis.fetch` with a spy, and capturing the function
 * reference at module load would freeze the original.
 */
export const DEFAULT_REQUEST_POLICY: RequestPolicy = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxRetries: DEFAULT_MAX_RETRIES,
  retryBaseDelayMs: DEFAULT_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: DEFAULT_RETRY_MAX_DELAY_MS,
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  fetchImpl: (input, init) => globalThis.fetch(input, init),
};

/**
 * Merge the provider-level options, the per-call overrides and the
 * defaults into one policy.
 */
export function resolvePolicy(
  options: LLMRequestOptions | undefined,
  overrides: { timeoutMs?: number; maxRetries?: number } = {},
): RequestPolicy {
  return {
    timeoutMs: overrides.timeoutMs ?? options?.timeoutMs ?? DEFAULT_REQUEST_POLICY.timeoutMs,
    maxRetries: overrides.maxRetries ?? options?.maxRetries ?? DEFAULT_REQUEST_POLICY.maxRetries,
    retryBaseDelayMs: options?.retryBaseDelayMs ?? DEFAULT_REQUEST_POLICY.retryBaseDelayMs,
    retryMaxDelayMs: options?.retryMaxDelayMs ?? DEFAULT_REQUEST_POLICY.retryMaxDelayMs,
    sleep: options?.sleep ?? DEFAULT_REQUEST_POLICY.sleep,
    fetchImpl: options?.fetchImpl ?? DEFAULT_REQUEST_POLICY.fetchImpl,
  };
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface JsonRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** The caller's cancellation signal, if any. */
  readonly signal?: AbortSignal;
  /** Secrets that must never appear in an error message. */
  readonly secrets?: readonly (string | undefined)[];
}

export interface JsonResponse<T> {
  readonly status: number;
  readonly payload: T;
  readonly headers: Headers;
}

/**
 * Send one JSON request, with retries.
 *
 * The retry loop lives here rather than in each provider so that "how many
 * times do we try" is answered in exactly one place.
 */
export async function sendJson<T>(
  request: JsonRequest,
  policy: RequestPolicy,
  overrides: { timeoutMs?: number; maxRetries?: number } = {},
): Promise<JsonResponse<T>> {
  const timeoutMs = overrides.timeoutMs ?? policy.timeoutMs;
  const maxRetries = overrides.maxRetries ?? policy.maxRetries;

  let attempt = 0;
  for (;;) {
    if (request.signal?.aborted) {
      throw new LLMError('ABORTED', 'The request was cancelled.');
    }
    try {
      return await attemptJson<T>(request, policy, timeoutMs);
    } catch (err) {
      const error =
        err instanceof LLMError
          ? err
          : new LLMError('NETWORK_ERROR', 'The request failed for an unknown reason.', {
              cause: err,
            });
      if (!error.retryable || attempt >= maxRetries) {
        throw error;
      }
      await policy.sleep(backoffDelay(error, attempt, policy));
      attempt += 1;
    }
  }
}

/**
 * How long to wait before the next attempt.
 *
 * `Retry-After` wins when the provider sent one — the provider knows its own
 * rate limit better than our backoff curve does. Otherwise the delay is
 * `base * 2^attempt`, capped.
 */
function backoffDelay(error: LLMError, attempt: number, policy: RequestPolicy): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(Math.max(error.retryAfterMs, 0), MAX_RETRY_AFTER_MS);
  }
  const exponential = policy.retryBaseDelayMs * 2 ** attempt;
  return Math.min(exponential, policy.retryMaxDelayMs);
}

/**
 * One attempt: fetch, read the body, classify the outcome.
 */
async function attemptJson<T>(
  request: JsonRequest,
  policy: RequestPolicy,
  timeoutMs: number,
): Promise<JsonResponse<T>> {
  if (request.signal?.aborted) {
    throw new LLMError('ABORTED', 'The request was cancelled.');
  }

  const controller = new AbortController();
  let timedOut = false;
  // The explicit type is the same one `packages/matching` uses for its own
  // timers: with both the DOM lib and @types/node in scope, `setTimeout` has
  // two overloads, and `ReturnType<typeof setTimeout>` picks the right handle
  // type for whichever one this compiler resolves.
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onUserAbort = (): void => controller.abort();
  request.signal?.addEventListener('abort', onUserAbort, { once: true });

  try {
    let res: Response;
    try {
      res = await policy.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
    } catch (err) {
      throw transportError(err, request, timedOut, timeoutMs);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw transportError(err, request, timedOut, timeoutMs);
    }

    if (!res.ok) {
      throw httpError(res, text, request);
    }

    let payload: T;
    try {
      payload = JSON.parse(text) as T;
    } catch (err) {
      throw new LLMError(
        'INVALID_RESPONSE',
        'The provider returned a response that is not valid JSON.',
        { status: res.status, cause: err },
      );
    }

    return { status: res.status, payload, headers: res.headers };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onUserAbort);
  }
}

/**
 * Turn a `fetch` rejection into the right `LLMError`.
 *
 * The order matters: a user cancellation outranks a timeout, because the
 * user is the reason the request stopped.
 */
function transportError(
  err: unknown,
  request: JsonRequest,
  timedOut: boolean,
  timeoutMs: number,
): LLMError {
  if (request.signal?.aborted) {
    return new LLMError('ABORTED', 'The request was cancelled.', { cause: err });
  }
  if (timedOut) {
    return new LLMError(
      'TIMEOUT_ERROR',
      `The request timed out after ${timeoutMs} ms. The provider may still be working on it.`,
      { cause: err },
    );
  }
  return new LLMError(
    'NETWORK_ERROR',
    'Could not reach the provider. Check your network connection and the base URL.',
    { cause: err },
  );
}

/**
 * Map an HTTP status onto the unified error model.
 *
 * The messages keep the wording the providers used before, because those
 * strings are what the UI (and the existing tests) already understand; only
 * the *classification* became uniform.
 */
function httpError(res: Response, bodyText: string, request: JsonRequest): LLMError {
  const status = res.status;
  const detail = extractErrorDetail(bodyText, request.secrets) || res.statusText || 'no details';
  const retryAfterMs = parseRetryAfter(res.headers.get('Retry-After'));

  if (status === 401) {
    return new LLMError('AUTHENTICATION_ERROR', `Invalid API key (401): ${detail}`, {
      status,
      retryable: false,
    });
  }
  if (status === 403) {
    return new LLMError(
      'AUTHENTICATION_ERROR',
      `Access denied — the key may not have access to this model (403): ${detail}`,
      { status, retryable: false },
    );
  }
  if (status === 404) {
    return new LLMError('PROVIDER_ERROR', `Model not found or wrong base URL (404): ${detail}`, {
      status,
      retryable: false,
    });
  }
  if (status === 429) {
    return new LLMError('RATE_LIMIT_ERROR', `Rate limit exceeded (429): ${detail}`, {
      status,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status === 529) {
    return new LLMError('PROVIDER_ERROR', `Provider overloaded (529): ${detail}`, {
      status,
      retryable: true,
      retryAfterMs,
    });
  }
  if (status >= 500) {
    return new LLMError('PROVIDER_ERROR', `Provider server error (${status}): ${detail}`, {
      status,
      retryable: true,
      retryAfterMs,
    });
  }
  return new LLMError('PROVIDER_ERROR', `LLM request failed (${status}): ${detail}`, {
    status,
    retryable: false,
  });
}

/**
 * Pull the human-readable part out of a provider's error body.
 *
 * The three providers disagree about the shape: OpenAI-compatible and
 * Anthropic use `{ error: { message } }`, Ollama uses `{ error: "…" }`, and
 * some gateways use a bare `{ message }`. All three are handled here, and
 * the result is redacted before it can reach a user.
 */
function extractErrorDetail(
  bodyText: string,
  secrets: readonly (string | undefined)[] | undefined,
): string {
  if (!bodyText) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = undefined;
  }
  const raw = pickErrorMessage(parsed);
  if (raw === undefined) return '';
  return redactSecrets(raw, secrets);
}

function pickErrorMessage(parsed: unknown): string | undefined {
  if (typeof parsed === 'string') return parsed;
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const err = obj['error'];
  if (typeof err === 'string') return err;
  if (err !== null && typeof err === 'object') {
    const message = (err as Record<string, unknown>)['message'];
    if (typeof message === 'string') return message;
  }
  const message = obj['message'];
  if (typeof message === 'string') return message;
  return undefined;
}

/**
 * Read a `Retry-After` header: either a number of seconds or an HTTP date.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isFinite(at)) {
    return Math.max(at - Date.now(), 0);
  }
  return undefined;
}
