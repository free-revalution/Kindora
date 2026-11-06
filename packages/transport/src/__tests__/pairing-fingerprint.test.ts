/**
 * Pairing fingerprints (Phase A / A3).
 *
 * The pairing code used to be a random secret. It is now the **host's
 * identity fingerprint** — a short authentication string derived from
 * the host's own long-term public key:
 *
 *     fingerprint = CrockfordBase32( SHA-256( utf8(agentId) || SPKI ) )[0..6]
 *
 * These tests pin the properties the pairing flow relies on:
 *
 *   - the shape (6 characters from an unambiguous alphabet);
 *   - the stability (the same identity always produces the same code);
 *   - the binding to the public key (a different key → a different code);
 *   - the human-friendliness (case/dash insensitive comparison).
 *
 * See 开发手册.md § 17 and `docs/REMEDIATION_TEST_REPORT.md` § 5.3.4.
 */
import { describe, it, expect } from 'vitest';
import { bytesToBase64 } from '@kindora/protocol';
import { ALPHABET } from '../pairing-code';
import {
  PAIRING_FINGERPRINT_LENGTH,
  crockfordBase32,
  derivePairingFingerprint,
  fingerprintsMatch,
  formatPairingFingerprint,
  pairingFingerprintFromPublicKey,
} from '../pairing-fingerprint';

const AGENT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_AGENT_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

/** A real SPKI blob, so the derivation is exercised on realistic bytes. */
async function generateSpki(): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  return new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
}

describe('pairing fingerprint — shape', () => {
  it('is six characters long', async () => {
    const fingerprint = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    expect(fingerprint).toHaveLength(PAIRING_FINGERPRINT_LENGTH);
    expect(PAIRING_FINGERPRINT_LENGTH).toBe(6);
  });

  it('uses only characters from the unambiguous alphabet', async () => {
    const fingerprint = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    for (const ch of fingerprint) {
      expect(ALPHABET).toContain(ch);
    }
  });

  it('never uses the visually ambiguous characters I, L, O, U', () => {
    // Crockford's Base32 drops I/L/O/U so a code read aloud cannot be
    // mis-transcribed.
    expect(ALPHABET).not.toContain('I');
    expect(ALPHABET).not.toContain('L');
    expect(ALPHABET).not.toContain('O');
    expect(ALPHABET).not.toContain('U');
    expect(ALPHABET).toHaveLength(32);
  });
});

describe('pairing fingerprint — derivation', () => {
  it('is stable for the same identity', async () => {
    const spki = await generateSpki();
    const first = await derivePairingFingerprint(AGENT_ID, spki);
    const second = await derivePairingFingerprint(AGENT_ID, spki);
    expect(first).toBe(second);
  });

  it('changes when the public key changes', async () => {
    const first = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    const second = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    expect(first).not.toBe(second);
  });

  it('changes when the agent id changes but the key does not', async () => {
    const spki = await generateSpki();
    const first = await derivePairingFingerprint(AGENT_ID, spki);
    const second = await derivePairingFingerprint(OTHER_AGENT_ID, spki);
    expect(first).not.toBe(second);
  });

  it('agrees with the base64 public-key variant', async () => {
    const spki = await generateSpki();
    const direct = await derivePairingFingerprint(AGENT_ID, spki);
    const fromBase64 = await pairingFingerprintFromPublicKey(AGENT_ID, bytesToBase64(spki));
    expect(fromBase64).toBe(direct);
  });

  it('does not embed the agent id in the clear', async () => {
    // The fingerprint is a digest, not a truncation of the identity.
    // The agent id is a lowercase dashed UUID, so it can never appear
    // verbatim in an uppercase, dash-free code.
    const fingerprint = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    expect(fingerprint).not.toContain('-');
    expect(fingerprint.toLowerCase()).not.toBe(AGENT_ID.toLowerCase());
  });
});

describe('pairing fingerprint — display', () => {
  it('groups the code for readability', () => {
    expect(formatPairingFingerprint('ABC123')).toBe('ABC-123');
  });

  it('normalises case and an existing dash', () => {
    expect(formatPairingFingerprint('abc123')).toBe('ABC-123');
    expect(formatPairingFingerprint('abc-123')).toBe('ABC-123');
    expect(formatPairingFingerprint('  abc123  ')).toBe('ABC-123');
  });

  it('leaves a short code alone', () => {
    expect(formatPairingFingerprint('AB')).toBe('AB');
    expect(formatPairingFingerprint('ABC')).toBe('ABC');
  });

  it('displays a real fingerprint in the grouped form', async () => {
    const fingerprint = await derivePairingFingerprint(AGENT_ID, await generateSpki());
    const displayed = formatPairingFingerprint(fingerprint);
    expect(displayed).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    expect(fingerprintsMatch(displayed, fingerprint)).toBe(true);
  });
});

describe('pairing fingerprint — comparison', () => {
  it('ignores case and the cosmetic dash', () => {
    expect(fingerprintsMatch('ABC123', 'abc123')).toBe(true);
    expect(fingerprintsMatch('ABC-123', 'ABC123')).toBe(true);
    expect(fingerprintsMatch('abc-123', 'ABC123')).toBe(true);
  });

  it('rejects a different fingerprint', () => {
    expect(fingerprintsMatch('ABC123', 'ABC124')).toBe(false);
    expect(fingerprintsMatch('ABC123', 'XYZ789')).toBe(false);
  });
});

describe('crockfordBase32', () => {
  it('packs bits most-significant-first', () => {
    expect(crockfordBase32(new Uint8Array([0x00]))).toBe('00');
    expect(crockfordBase32(new Uint8Array([0x01]))).toBe('04');
    expect(crockfordBase32(new Uint8Array([0xff]))).toBe('ZW');
  });

  it('emits one character per five bits', () => {
    for (const length of [1, 2, 3, 16, 32, 33]) {
      const bytes = new Uint8Array(length).fill(0xab);
      expect(crockfordBase32(bytes)).toHaveLength(Math.ceil((length * 8) / 5));
    }
  });

  it('uses only alphabet characters', () => {
    const out = crockfordBase32(new Uint8Array(32).fill(0x5a));
    for (const ch of out) {
      expect(ALPHABET).toContain(ch);
    }
  });
});
