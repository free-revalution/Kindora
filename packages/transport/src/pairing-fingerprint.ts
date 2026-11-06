/**
 * Pairing fingerprints — the out-of-band identity check for KSA (Phase A / A3).
 *
 * ## Why the pairing code changed
 *
 * KSA 0.1 originally used a **random 6-character pairing code**: the
 * host minted a secret and the joiner typed it in. That proves only
 * that the joiner reached the right room — it says nothing about *who*
 * is on the other end. A hostile device that answers the discovery
 * broadcast first would receive the joiner's traffic.
 *
 * A pairing **fingerprint** fixes that. The code the host shows is
 * derived from the host's own long-term identity key:
 *
 * ```text
 * fingerprint = CrockfordBase32( SHA-256( utf8(agentId) || SPKI_DER ) )[0..6]
 * ```
 *
 * Six Crockford characters carry 30 bits and are read out loud without
 * ambiguity (no I / L / O / U). The joiner recomputes the fingerprint
 * from the public key the host presents in its `hello` and compares it
 * with what the user typed. A mismatch means the peer is not the host
 * the user expected, and the handshake is aborted.
 *
 * This is a **short authentication string** (SAS) in the Bluetooth /
 * Wi-Fi-Display tradition: the human is the out-of-band channel.
 *
 * ## What this is NOT
 *
 * The fingerprint is *not* a password and *not* a temporary key. It
 * grants no access on its own — the session is still authenticated by
 * the A2 signature over every envelope. The fingerprint only binds the
 * session to the identity the user was shown. The UI must say so
 * plainly: "identity fingerprint", never "password" or "passcode".
 *
 * See 开发手册.md § 17, and `docs/REMEDIATION_TEST_REPORT.md` § 5.3.4.
 */

import { base64ToBytes, sha256 } from '@kindora/protocol';
import { ALPHABET } from './pairing-code';

/** Number of characters in a pairing fingerprint. */
export const PAIRING_FINGERPRINT_LENGTH = 6;

/**
 * Derive the pairing fingerprint of an agent.
 *
 * @param agentId  the agent's UUID (UTF-8 encoded into the digest)
 * @param spkiDer  the agent's SPKI DER public key
 */
export async function derivePairingFingerprint(
  agentId: string,
  spkiDer: Uint8Array,
): Promise<string> {
  const digest = await sha256(concatBytes(new TextEncoder().encode(agentId), spkiDer));
  return crockfordBase32(digest).slice(0, PAIRING_FINGERPRINT_LENGTH);
}

/**
 * Derive the pairing fingerprint from the base64 SPKI that travels on
 * the wire (`Agent.publicKey`).
 */
export async function pairingFingerprintFromPublicKey(
  agentId: string,
  publicKeyBase64: string,
): Promise<string> {
  return derivePairingFingerprint(agentId, base64ToBytes(publicKeyBase64));
}

/**
 * Format a fingerprint for display: `A1B2-C3`.
 *
 * The dash is cosmetic — `normalisePairingCode` strips it.
 */
export function formatPairingFingerprint(fingerprint: string): string {
  const clean = fingerprint.replace(/[\s-]/g, '').toUpperCase();
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)}-${clean.slice(3, PAIRING_FINGERPRINT_LENGTH)}`;
}

/**
 * Compare two fingerprints.
 *
 * Comparison is case-insensitive and ignores the cosmetic dash, so a
 * user can type the fingerprint exactly as it is displayed.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  const normalise = (value: string): string => value.replace(/[\s-]/g, '').toUpperCase();
  return normalise(a) === normalise(b);
}

/**
 * Encode bytes as Crockford's Base32.
 *
 * Bit-packed most-significant-first, 5 bits per character, padded with
 * zero bits at the end — the same layout Crockford's Base32 uses.
 */
export function crockfordBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0x1f] ?? '0';
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f] ?? '0';
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
