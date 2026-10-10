/**
 * Sensitive-field guard — Phase 11.
 *
 * Defense in depth on top of the protocol boundary rules (§ 16):
 *   - No envelope payload may carry API keys, private keys, secrets,
 *     passwords, or full conversation history.
 *
 * This module walks every string field of an envelope (recursively, to
 * a depth cap) and rejects:
 *   - Field names like `apiKey`, `privateKey`, `secret`, `password`,
 *     `token` etc.
 *   - Values that look like API keys (sk-..., sk-ant-..., ghp_...,
 *     Bearer ...).
 *   - Values that look like PEM-encoded private keys.
 *
 * Used by `PairingSession.send()` so a developer's mistake (e.g.
 * accidentally forwarding the LLM API key into a profile_exchange
 * payload) is caught before it ever leaves the device.
 *
 * The guard is intentionally strict — false positives (a value that
 * happens to look like a token) are preferable to silently leaking a
 * real one. The protocol's own envelope validator rejects invalid
 * payloads; this guard rejects valid-but-dangerous payloads.
 *
 * See 开发手册.md § 11, § 16, Phase 11.
 */

const FORBIDDEN_FIELD_NAMES = new Set([
  'apiKey',
  'apikey',
  'api_key',
  'privateKey',
  'private_key',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'pwd',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'bearerToken',
  'bearer_token',
  'authorization',
]);

const FORBIDDEN_VALUE_PATTERNS: readonly RegExp[] = [
  // OpenAI / OpenAI-compatible API keys (sk-..., sk-ant-...)
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  // Anthropic API keys (sk-ant-api03-...)
  /\bsk-ant-api[A-Za-z0-9_-]{16,}\b/,
  // GitHub personal tokens (ghp_..., ghs_..., gho_...)
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  // PEM private key block (any flavour)
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  // Bearer tokens (Authorization: Bearer xxx)
  /\bBearer\s+[A-Za-z0-9_\-.=]{16,}/i,
  // AWS access keys (AKIA...)
  /\bAKIA[0-9A-Z]{16}\b/,
];

export class SensitiveFieldError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly reason: 'forbidden-field-name' | 'forbidden-value-pattern',
  ) {
    super(message);
    this.name = 'SensitiveFieldError';
  }
}

export interface SensitiveFieldGuardOptions {
  /** Max recursion depth — defaults to 6. */
  readonly maxDepth?: number;
  /** Max string length to scan — defaults to 2000. */
  readonly maxStringLength?: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_STRING_LENGTH = 2000;

/**
 * Walk `value` (typically an envelope payload or the envelope itself)
 * and throw a `SensitiveFieldError` if a forbidden field name or value
 * is detected. Otherwise returns silently.
 */
export function assertNoSensitiveFields(
  value: unknown,
  options: SensitiveFieldGuardOptions = {},
  path: string = '$',
): void {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxLen = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
  walk(value, path, maxDepth, maxLen);
}

function walk(value: unknown, path: string, maxDepth: number, maxLen: number): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > maxLen) return; // Cap scan length to keep cost bounded.
    for (const pat of FORBIDDEN_VALUE_PATTERNS) {
      if (pat.test(value)) {
        throw new SensitiveFieldError(
          `Refusing to send: payload contains a value that looks like a credential at ${path}.`,
          path,
          'forbidden-value-pattern',
        );
      }
    }
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (maxDepth <= 0) return;
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, maxDepth - 1, maxLen);
    }
    return;
  }
  if (maxDepth <= 0) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELD_NAMES.has(k)) {
      throw new SensitiveFieldError(
        `Refusing to send: payload contains forbidden field "${k}" at ${path}.${k}.`,
        `${path}.${k}`,
        'forbidden-field-name',
      );
    }
    walk(v, `${path}.${k}`, maxDepth - 1, maxLen);
  }
}

/**
 * Strip the guard's verdict into a short, user-facing string — for
 * the Settings error UI and for logging. NEVER include the offending
 * value itself (per § 11 — "API Key 禁止: 写入日志").
 */
export function formatSensitiveFieldError(err: SensitiveFieldError): string {
  return `Refused to send envelope: a forbidden field or credential-like value was detected (${err.path}).`;
}