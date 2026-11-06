/**
 * Sensitive-field guard — Phase 11, hardened in Phase F1.
 *
 * Defense in depth on top of the protocol boundary rules (§ 16):
 *   - No envelope payload may carry API keys, private keys, secrets,
 *     passwords, or full conversation history.
 *
 * The Phase 11 version had three holes, all of them of the same shape:
 * **it gave up quietly instead of refusing.**
 *
 *   1. A string longer than `maxStringLength` was *skipped* — so
 *      `"sk-" + "a".repeat(10_000)` sailed through untouched.
 *   2. A container deeper than `maxDepth` was *skipped* — so a
 *      credential nested ten levels down was never looked at.
 *   3. Field names were matched case-sensitively — so `APIKEY`,
 *      `Api_Key` and `PassWord` were all fine.
 *
 * Phase F1 closes them. The rule is now: **when in doubt, refuse.**
 *
 *   1. Field names are **normalised** (lower-cased, separators removed)
 *      and matched against an explicit rule table — `apiKey`, `API_KEY`
 *      and `Api-Key` all hit the same rule.
 *   2. Values that look like credentials are refused (API keys, JWTs,
 *      PEM private keys, bearer tokens, cloud access keys, …).
 *   3. Long strings are **scanned in full**, in overlapping chunks — a
 *      long string is never silently skipped.
 *   4. Structures deeper than `maxDepth` are **refused**, not skipped.
 *   5. Payloads beyond the node / character budget are refused.
 *   6. Values that cannot be verified (functions, class instances,
 *      non-finite numbers, cycles) are refused.
 *
 * A payload we cannot fully inspect is a payload we must not send.
 *
 * Used by `PairingSession.send()` so a developer's mistake (e.g.
 * accidentally forwarding the LLM API key into a profile_exchange
 * payload) is caught before it ever leaves the device.
 *
 * See 开发手册.md § 11, § 16, Phase 11, Phase F1.
 */

/* ------------------------------------------------------------------ */
/* Field-name rules                                                     */
/* ------------------------------------------------------------------ */

/**
 * Known-**public** field names, in normalised form.
 *
 * Checked **first**, and never refused. They carry public key material
 * or a non-secret identifier that the protocol is *supposed* to
 * exchange — refusing `publicKey` would break the handshake, and
 * refusing `sessionKeyExchange` would break the ephemeral key
 * exchange.
 *
 * Being on this list only exempts the **name**. The *value* is still
 * scanned: a `publicKey` whose value is a PEM private key is still
 * refused.
 */
const ALLOWED_PUBLIC_FIELD_NAMES: ReadonlySet<string> = new Set([
  'publickey',
  'publickeys',
  'ephemeralpublickey',
  'sessionkeyexchange',
  'keyid',
  'publickeyfingerprint',
  'hostpublickeyfingerprint',
  'keyfingerprint',
  'fingerprint',
]);

/**
 * Forbidden field names, in normalised form (see `normaliseFieldName`).
 *
 * Phase F1 requirement 1 + 2: one explicit rule per sensitive
 * concept, applied to the *normalised* name so that casing and
 * separator variants cannot slip past.
 */
const FORBIDDEN_NORMALISED_NAMES: ReadonlySet<string> = new Set([
  // API keys & secrets
  'apikey',
  'apikeys',
  'apisecret',
  'apisecrets',
  'secret',
  'secrets',
  'secretkey',
  'secretkeys',
  'clientsecret',
  'clientsecrets',
  'credentials',
  'credential',
  // Private keys
  'privatekey',
  'privatekeys',
  'privkey',
  'privkeys',
  'privatekeypem',
  // Passwords
  'password',
  'passwords',
  'passwd',
  'passphrase',
  'passphrases',
  'pwd',
  // Access / refresh / bearer tokens
  'token',
  'tokens',
  'accesstoken',
  'accesstokens',
  'refreshtoken',
  'refreshtokens',
  'bearertoken',
  'bearertokens',
  'idtoken',
  'authtoken',
  'sessiontoken',
  'apitoken',
  // Auth headers & cookies
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  // Seed phrases
  'mnemonic',
  'seedphrase',
]);

/**
 * Forbidden **word pairs**. A field name is refused when it contains
 * both words in this order — e.g. `apiKey`, `X-Api-Key`, `my_api_key`.
 *
 * `publicKey` is deliberately **not** here: a public key is exactly
 * what the protocol is supposed to exchange, and `publicKey` appears
 * on the allow list above. `sessionKey` *is* here — the negotiated
 * session key is a secret — and the legitimate `sessionKeyExchange`
 * field is exempted by the allow list above.
 */
const FORBIDDEN_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'],
  ['private', 'key'],
  ['secret', 'key'],
  ['client', 'secret'],
  ['access', 'token'],
  ['refresh', 'token'],
  ['bearer', 'token'],
  ['id', 'token'],
  ['auth', 'token'],
  ['session', 'key'],
  ['encryption', 'key'],
  ['signing', 'key'],
  ['seed', 'phrase'],
];

/**
 * Forbidden **single words**. A field name is refused when any of its
 * word segments is one of these.
 */
const FORBIDDEN_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'authorization',
  'credential',
  'credentials',
  'mnemonic',
]);

/**
 * Lower-case the name and drop every non-alphanumeric character.
 *
 * `apiKey` / `API_KEY` / `api-key` / `ApiKey` all become `apikey`.
 */
function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Split a field name into lower-case word segments.
 *
 * `apiKey` → `['api', 'key']`, `APIKey` → `['api', 'key']`,
 * `X-Api-Key` → `['x', 'api', 'key']`.
 */
function wordSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/* ------------------------------------------------------------------ */
/* Value rules                                                          */
/* ------------------------------------------------------------------ */

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
  // JSON Web Tokens (header.payload.signature)
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  // Stripe-style keys (sk_live_..., pk_live_...)
  /\b[sp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  /\bxox[abprs]-[A-Za-z0-9-]{16,}\b/,
  // Google API keys (AIza...)
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

/* ------------------------------------------------------------------ */
/* Errors                                                               */
/* ------------------------------------------------------------------ */

/**
 * Why a payload was refused.
 *
 * Phase F1 requirement 7 — "无法验证的数据应拒绝，而不是默认通过" — is
 * why this is more than "bad field / bad value": there are now
 * explicit reasons for *refusing to inspect* something.
 */
export type SensitiveFieldReason =
  /** The field name matched the forbidden-name rules. */
  | 'forbidden-field-name'
  /** The value matched a credential-shaped pattern. */
  | 'forbidden-value-pattern'
  /** The structure is nested deeper than the guard is willing to walk. */
  | 'max-depth-exceeded'
  /** The payload is larger than the guard's node / character budget. */
  | 'payload-too-large'
  /** The value cannot be verified (function, class instance, NaN, cycle). */
  | 'unverifiable-value';

export class SensitiveFieldError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly reason: SensitiveFieldReason,
  ) {
    super(message);
    this.name = 'SensitiveFieldError';
  }
}

/* ------------------------------------------------------------------ */
/* Options                                                              */
/* ------------------------------------------------------------------ */

export interface SensitiveFieldGuardOptions {
  /**
   * Max recursion depth — defaults to 8.
   *
   * A real envelope reaches depth 4 (`envelope → payload → profile →
   * interests[]`), so 8 leaves headroom. Anything deeper is **refused**
   * (`max-depth-exceeded`), not skipped.
   */
  readonly maxDepth?: number;
  /**
   * The per-pass scan window for strings — defaults to 2000 chars.
   *
   * A string longer than this is **not** skipped: it is scanned in
   * overlapping chunks until its end. This is the Phase F1 fix for
   * "超过最大长度时不能静默放行".
   */
  readonly maxStringLength?: number;
  /**
   * Max total characters across every string in the payload — defaults
   * to 262144 (256 KiB). Beyond it the payload is refused
   * (`payload-too-large`).
   */
  readonly maxTotalStringLength?: number;
  /**
   * Max number of containers (objects + arrays) in the payload —
   * defaults to 2000. Beyond it the payload is refused
   * (`payload-too-large`).
   */
  readonly maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING_LENGTH = 2000;
const DEFAULT_MAX_TOTAL_STRING_LENGTH = 262_144;
const DEFAULT_MAX_NODES = 2000;

/**
 * How much of the previous chunk is repeated at the start of the next
 * one. It has to be longer than the longest credential shape we look
 * for, otherwise a key straddling a chunk boundary would be missed.
 * The longest pattern below is the PEM header (~48 chars).
 */
const CHUNK_OVERLAP = 128;

/* ------------------------------------------------------------------ */
/* The guard                                                            */
/* ------------------------------------------------------------------ */

interface GuardState {
  readonly maxDepth: number;
  readonly chunkSize: number;
  readonly maxTotalStringLength: number;
  readonly maxNodes: number;
  /** Containers visited so far — the size budget. */
  nodes: number;
  /** Characters seen so far — the size budget. */
  chars: number;
  /**
   * Containers currently being walked (a stack, not a set of all
   * visited nodes) — this is what makes a *cycle* detectable without
   * mistaking a shared (non-cyclic) reference for one.
   */
  readonly stack: Set<object>;
}

/**
 * Walk `value` (typically an envelope payload or the envelope itself)
 * and throw a `SensitiveFieldError` if it contains anything we must
 * not send — or anything we cannot verify.
 *
 * Returns silently only when the whole payload was inspected and found
 * clean.
 */
export function assertNoSensitiveFields(
  value: unknown,
  options: SensitiveFieldGuardOptions = {},
  path: string = '$',
): void {
  const state: GuardState = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    chunkSize: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxTotalStringLength: options.maxTotalStringLength ?? DEFAULT_MAX_TOTAL_STRING_LENGTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    nodes: 0,
    chars: 0,
    stack: new Set<object>(),
  };
  walk(value, path, 0, state);
}

function walk(value: unknown, path: string, depth: number, state: GuardState): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    scanString(value, path, state);
    return;
  }
  if (typeof value === 'boolean') return;
  if (typeof value === 'number') {
    // NaN / Infinity serialise to `null` — the peer would receive
    // something different from what we checked. Refuse it.
    if (!Number.isFinite(value)) {
      throw new SensitiveFieldError(
        `Refusing to send: payload contains a non-finite number at ${path}.`,
        path,
        'unverifiable-value',
      );
    }
    return;
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new SensitiveFieldError(
      `Refusing to send: payload contains a value of type "${typeof value}" at ${path}, which cannot be verified.`,
      path,
      'unverifiable-value',
    );
  }

  // From here on the value is an object or an array.
  const container = value as object;
  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    throw new SensitiveFieldError(
      `Refusing to send: payload contains more than ${state.maxNodes} values.`,
      path,
      'payload-too-large',
    );
  }
  if (state.stack.has(container)) {
    throw new SensitiveFieldError(
      `Refusing to send: payload contains a circular reference at ${path}.`,
      path,
      'unverifiable-value',
    );
  }
  if (depth >= state.maxDepth) {
    throw new SensitiveFieldError(
      `Refusing to send: payload is nested deeper than ${state.maxDepth} levels at ${path}.`,
      path,
      'max-depth-exceeded',
    );
  }

  state.stack.add(container);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`, depth + 1, state);
      }
      return;
    }

    // Only plain objects can be inspected faithfully. A class instance
    // may carry state in non-enumerable properties or behind getters,
    // and `JSON.stringify` would not send those — but we would not
    // have checked them either, so we refuse rather than guess.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new SensitiveFieldError(
        `Refusing to send: payload contains a non-plain object at ${path}, which cannot be verified.`,
        path,
        'unverifiable-value',
      );
    }

    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertFieldNameAllowed(k, `${path}.${k}`);
      walk(v, `${path}.${k}`, depth + 1, state);
    }
  } finally {
    state.stack.delete(container);
  }
}

/**
 * Apply the field-name rules. Public field names are exempt; everything
 * else must not match the forbidden-name table, a forbidden word pair,
 * or a forbidden single word.
 */
function assertFieldNameAllowed(key: string, path: string): void {
  const normalised = normaliseFieldName(key);
  if (ALLOWED_PUBLIC_FIELD_NAMES.has(normalised)) return;

  const segments = wordSegments(key);
  const hasPair = FORBIDDEN_WORD_PAIRS.some(([a, b]) => containsPair(segments, a, b));
  const hasWord = segments.some((s) => FORBIDDEN_WORDS.has(s));
  const isExact = FORBIDDEN_NORMALISED_NAMES.has(normalised);

  if (isExact || hasPair || hasWord) {
    throw new SensitiveFieldError(
      `Refusing to send: payload contains forbidden field "${key}" at ${path}.`,
      path,
      'forbidden-field-name',
    );
  }
}

/** True when `segments` contains `first` followed later by `second`. */
function containsPair(segments: readonly string[], first: string, second: string): boolean {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== first) continue;
    for (let j = i + 1; j < segments.length; j++) {
      if (segments[j] === second) return true;
    }
  }
  return false;
}

/**
 * Scan a string for credential shapes.
 *
 * The whole string is scanned — in overlapping chunks when it is longer
 * than the scan window. It is never skipped.
 */
function scanString(value: string, path: string, state: GuardState): void {
  state.chars += value.length;
  if (state.chars > state.maxTotalStringLength) {
    throw new SensitiveFieldError(
      `Refusing to send: payload contains more than ${state.maxTotalStringLength} characters of text.`,
      path,
      'payload-too-large',
    );
  }

  const chunk = state.chunkSize;
  if (value.length <= chunk) {
    assertNoCredentialPattern(value, path);
    return;
  }

  for (let start = 0; start < value.length; start += chunk) {
    const end = Math.min(start + chunk + CHUNK_OVERLAP, value.length);
    assertNoCredentialPattern(value.slice(start, end), path);
    if (end >= value.length) break;
  }
}

function assertNoCredentialPattern(value: string, path: string): void {
  for (const pat of FORBIDDEN_VALUE_PATTERNS) {
    if (pat.test(value)) {
      throw new SensitiveFieldError(
        `Refusing to send: payload contains a value that looks like a credential at ${path}.`,
        path,
        'forbidden-value-pattern',
      );
    }
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
