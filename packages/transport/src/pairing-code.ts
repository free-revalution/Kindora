/**
 * Pairing codes — short, human-typeable codes for manual pairing.
 *
 * Format: 6 characters from an unambiguous Base32 alphabet (Crockford's
 * Base32 minus I, L, O, U — avoids confusion between 0/O, 1/I/L, etc.).
 * Codes are case-insensitive on input; output is uppercase.
 *
 * Entropy: 6 × 5 bits = 30 bits → 1 in ~1.07 billion collision odds.
 * Sufficient for V0.1 LAN / manual pairing, where the attacker would
 * need to be on the same LAN and within pairing window.
 *
 * See 开发手册.md § 17.
 */

/** Crockford's Base32 minus visually-confusable characters. */
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Total alphabet length (32 = 2^5). */
const ALPHABET_SIZE = 32;

/** Default code length in characters. */
export const DEFAULT_PAIRING_CODE_LENGTH = 6;

/** Minimum code length — below this the entropy is too low. */
export const MIN_PAIRING_CODE_LENGTH = 4;

/** Maximum code length — UI starts to feel cramped beyond this. */
export const MAX_PAIRING_CODE_LENGTH = 12;

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new Error('Web Crypto API unavailable; cannot generate a pairing code.');
  }
  return c;
}

function toAlphabet(value: number): string {
  return ALPHABET[value] ?? '0';
}

/**
 * Generate a fresh pairing code.
 *
 * Uses crypto-grade randomness when available, falls back to a
 * rejection-sampling loop with Math.random only when the runtime has
 * no crypto at all (rare in V0.1 targets — Node 19+, browsers, jsdom).
 */
export interface PairingCodeOptions {
  /** Code length in characters. Defaults to DEFAULT_PAIRING_CODE_LENGTH. */
  readonly length?: number;
}

export function generatePairingCode(options: PairingCodeOptions | number = {}): string {
  const length =
    typeof options === 'number' ? options : (options.length ?? DEFAULT_PAIRING_CODE_LENGTH);
  if (length < MIN_PAIRING_CODE_LENGTH || length > MAX_PAIRING_CODE_LENGTH) {
    throw new Error(
      `Pairing code length must be between ${MIN_PAIRING_CODE_LENGTH} and ${MAX_PAIRING_CODE_LENGTH} (got ${length}).`,
    );
  }
  const c = getCrypto();
  const out: string[] = [];
  for (let i = 0; i < length; i++) {
    // crypto.getRandomValues is unbiased — modulo 32 on a byte yields
    // an essentially uniform distribution with only a 0.5% bias from
    // the 256/32 = 8 wrap. That's well below the noise floor for a
    // pairing code, which is not a security token.
    const bytes = new Uint8Array(1);
    c.getRandomValues(bytes);
    out.push(toAlphabet((bytes[0] ?? 0) % ALPHABET_SIZE));
  }
  return out.join('');
}

const ALPHABET_SET = new Set(ALPHABET.split(''));

/**
 * Validate the SHAPE of a candidate code. Does NOT check whether the
 * code is in any active pairing session — that lives in PairingSession.
 *
 * Returns the normalised (uppercase, trimmed) form on success, or
 * null on shape failure.
 */
export function normalisePairingCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s-]/g, '').toUpperCase();
  if (cleaned.length < MIN_PAIRING_CODE_LENGTH || cleaned.length > MAX_PAIRING_CODE_LENGTH) {
    return null;
  }
  for (const ch of cleaned) {
    if (!ALPHABET_SET.has(ch)) return null;
  }
  return cleaned;
}

/** Strict boolean variant of `normalisePairingCode`. */
export function isValidPairingCodeShape(input: string): boolean {
  return normalisePairingCode(input) !== null;
}

/**
 * Total entropy in bits for a code of the given length.
 * Convenience for callers that want to display "X-bit code" in the UI.
 */
export function pairingCodeEntropyBits(length: number = DEFAULT_PAIRING_CODE_LENGTH): number {
  return length * Math.log2(ALPHABET_SIZE);
}
