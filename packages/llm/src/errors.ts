/**
 * The unified LLM error model — Phase E1.
 *
 * Every provider in this package throws `LLMError` and nothing else, so a
 * caller can branch on `error.code` instead of pattern-matching on English
 * prose that differs per provider.
 *
 * The seven codes are the ones the remediation task book prescribes
 * (`docs/修复.md` § 八 E1):
 *
 * | code | meaning | retryable by default |
 * | --- | --- | --- |
 * | `AUTHENTICATION_ERROR` | 401 / 403 — the key is missing, wrong, or not allowed | no |
 * | `RATE_LIMIT_ERROR` | 429 — the provider is throttling us | yes (honours `Retry-After`) |
 * | `TIMEOUT_ERROR` | the request exceeded its deadline | no |
 * | `NETWORK_ERROR` | the request never reached the provider | yes |
 * | `INVALID_RESPONSE` | the provider answered with something we cannot use | no |
 * | `PROVIDER_ERROR` | any other provider-side failure (404, 5xx, …) | only for 5xx |
 * | `ABORTED` | the caller cancelled the request | no |
 *
 * **Why a timeout is not retried.** A timeout means "we stopped waiting" — it
 * does *not* mean "the provider never ran the request". The provider may have
 * received it, run it, and billed for it. Retrying would send a second paid
 * request for the same answer, which the task book explicitly rules out
 * ("避免重复发送付费请求"). The same reasoning applies to `INVALID_RESPONSE`:
 * the provider *did* answer, we just could not parse it.
 *
 * A `NETWORK_ERROR` is the opposite case: the connection failed before the
 * request could be delivered, so retrying cannot double-bill.
 */

/** The seven error categories every provider must use. */
export type LLMErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'TIMEOUT_ERROR'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'PROVIDER_ERROR'
  | 'ABORTED';

export interface LLMErrorInit {
  /** The HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /**
   * Whether a retry could plausibly succeed.
   * Defaults to the per-code table below; 5xx `PROVIDER_ERROR`s override it.
   */
  readonly retryable?: boolean;
  /** How long the provider asked us to wait (`Retry-After`), in milliseconds. */
  readonly retryAfterMs?: number;
  /** The underlying error, if any. Never contains credentials. */
  readonly cause?: unknown;
}

/**
 * Which codes are retryable when the caller does not say otherwise.
 *
 * `PROVIDER_ERROR` is `false` here because it covers both "model not found"
 * (404 — hopeless) and "server error" (5xx — worth one more try). The HTTP
 * layer sets the flag explicitly for the 5xx case.
 */
const DEFAULT_RETRYABLE: Record<LLMErrorCode, boolean> = {
  AUTHENTICATION_ERROR: false,
  RATE_LIMIT_ERROR: true,
  TIMEOUT_ERROR: false,
  NETWORK_ERROR: true,
  INVALID_RESPONSE: false,
  PROVIDER_ERROR: false,
  ABORTED: false,
};

/**
 * The error every provider throws.
 *
 * `code` is the machine-readable part; `message` is what the user sees.
 * The message never contains the API key — see `redactSecrets`.
 */
export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: LLMErrorCode, message: string, init: LLMErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LLMError';
    this.code = code;
    this.status = init.status;
    this.retryable = init.retryable ?? DEFAULT_RETRYABLE[code];
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Narrow an unknown value to an `LLMError`. */
export function isLLMError(value: unknown): value is LLMError {
  return value instanceof LLMError;
}

/** Shortest secret we bother redacting. Below this, redaction would eat prose. */
const MIN_REDACTABLE_SECRET_LENGTH = 4;

/**
 * Remove credentials from a string that is about to be shown to a user or
 * written to a log.
 *
 * Three layers, because a leak can come from three directions:
 *
 * 1. **The exact key we hold** — the provider echoed our `Authorization`
 *    header back in its error body. This is the case the task book calls out
 *    ("API Key 不得出现在日志和错误提示中").
 * 2. **Any bearer token** — a proxy or gateway may report the header it
 *    received, which is not necessarily the key we sent.
 * 3. **Key-shaped strings** — a provider error that quotes *another* secret
 *    (the user pasted a key into a prompt, a proxy injected one).
 *
 * Secrets shorter than {@link MIN_REDACTABLE_SECRET_LENGTH} characters are
 * left alone: redacting a 1–3 character string would shred ordinary English.
 */
export function redactSecrets(text: string, secrets?: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets ?? []) {
    if (!secret || secret.length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]');
  out = out.replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, '[redacted]');
  return out;
}
