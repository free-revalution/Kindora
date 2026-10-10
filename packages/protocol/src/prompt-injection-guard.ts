/**
 * Prompt-injection sanitiser — Phase 11.
 *
 * Defense in depth on top of the existing UNTRUSTED framing in the
 * match / icebreaker / chat-assist system prompts (§ 35). Whenever
 * we forward peer-supplied text (peer profile fields, chat history,
 * match analysis values) into a user message we route it through
 * `sanitiseUntrustedText` first.
 *
 * The sanitiser:
 *   1. Truncates to a per-call cap (defaults to 1200 chars) so a
 *      malicious peer cannot inflate a single context window.
 *   2. Replaces common prompt-injection control phrases with safe
 *      placeholders so the model can't be tricked into thinking the
 *      instructions came from the system rather than from data.
 *   3. Collapses runs of whitespace (so the model still sees
 *      paragraph boundaries).
 *
 * It is NOT a substitute for the system prompt's UNTRUSTED framing —
 * the system prompt is the primary defence, this sanitiser is just
 * belt-and-suspenders. The two together are what § 35 / § 36 require.
 *
 * See 开发手册.md § 35, § 36, Phase 11.
 */

const INJECTION_PHRASES: readonly RegExp[] = [
  /\bignore (?:all )?(?:previous|prior|above) instructions?\b/gi,
  /\bignore (?:your|the) (?:rules?|system|instructions?)\b/gi,
  /\bdisregard (?:all )?(?:previous|prior|above) (?:instructions?|rules?|prompts?|chain)\b/gi,
  /\bforget (?:everything|all) (?:above|before|so far)\b/gi,
  /\byou a new line\b/gi,
  // Role prefix injections — match "system:" / "system\n" / "system "
  // followed by alphabetic content (the model should never see "system"
  // introduce user-supplied text).
  /\bsystem[ \t]*[:\n][ \t]*[A-Za-z]/gi,
  /\bassistant[ \t]*[:\n][ \t]*[A-Za-z]/gi,
  /\bhuman[ \t]*[:\n][ \t]*[A-Za-z]/gi,
  // Chat-template markers. <|...|> uses | as the bracket — strip them.
  /<\|[A-Za-z0-9_]+\|>/g,
  // JSON-block injections
  /\{[^{}]*"(?:role|instruction|prompt|system)"[^{}]*\}/gi,
];

const SAFE_PLACEHOLDER = '[untrusted-text-stripped]';

export interface SanitiseOptions {
  /** Hard cap on the resulting length. Default: 1200. */
  readonly maxLength?: number;
  /**
   * If true (default), replace injection phrases with a safe
   * placeholder. If false, only truncate + collapse whitespace.
   */
  readonly stripControlPhrases?: boolean;
}

const DEFAULT_MAX_LENGTH = 1200;

/**
 * Sanitise a piece of untrusted text before forwarding it into an
 * LLM user message. Truncates to `maxLength` chars. Pure — no I/O.
 */
export function sanitiseUntrustedText(text: string, options: SanitiseOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const stripControlPhrases = options.stripControlPhrases ?? true;

  if (typeof text !== 'string') return '';
  let out = text;

  if (stripControlPhrases) {
    for (const pat of INJECTION_PHRASES) {
      out = out.replace(pat, SAFE_PLACEHOLDER);
    }
  }

  // Collapse runs of whitespace (including newlines) — keeps paragraph
  // boundaries but bounds the size of the resulting tokens.
  out = out.replace(/\s+/g, ' ').trim();

  if (out.length > maxLength) {
    out = out.slice(0, maxLength) + ' …';
  }
  return out;
}

/**
 * Walk an object (typically a profile / analysis payload received
 * from a peer) and sanitise every string leaf. Pure — returns a fresh
 * object, doesn't mutate the input.
 */
export function sanitiseUntrustedPayload(value: unknown, options: SanitiseOptions = {}): unknown {
  return walk(value, options, 0, 6);
}

function walk(value: unknown, options: SanitiseOptions, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitiseUntrustedText(value, options);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, options, depth + 1, maxDepth));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = walk(v, options, depth + 1, maxDepth);
  }
  return out;
}

/** Re-export the placeholder for callers / tests that want to assert. */
export const UNTRUSTED_PLACEHOLDER = SAFE_PLACEHOLDER;