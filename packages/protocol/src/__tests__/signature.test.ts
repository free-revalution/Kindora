/**
 * Envelope signatures (Phase A / A2).
 *
 * A KSA envelope's `sender` field is a self-asserted UUID. Without a
 * signature, anything on the wire can claim to be anyone. These tests
 * pin the three properties the scheme depends on:
 *
 *   1. a signature made over an envelope verifies;
 *   2. **any** change to the signed content makes it fail;
 *   3. a signature is bound to one recipient, so it cannot be lifted
 *      out of one pairing and replayed into another.
 *
 * The algorithm is real: ECDSA P-256 / SHA-256 via WebCrypto. No
 * mocks, no stubs — a test that "verifies" with a fake verifier proves
 * nothing about the wire format.
 *
 * See 开发手册.md § 13, and `docs/REMEDIATION_TEST_REPORT.md` § 5.2.
 */
import { describe, it, expect } from 'vitest';
import {
  ES256_SIGNATURE_BYTES,
  SIGNATURE_ALG,
  SIGNING_INPUT_HEADER,
  SIGNING_SCHEME,
  buildSigningInput,
  bytesToBase64Url,
  canonicalizeToBytes,
  deriveKeyId,
  isBase64UrlOfLength,
  sha256,
  signEnvelope,
  verifyEnvelopeSignature,
  type KsaSignature,
  type SignableEnvelope,
} from '../index';

const SENDER_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const PEER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

interface TestKey {
  readonly privateKey: CryptoKey;
  readonly publicKeySpki: Uint8Array;
  readonly keyId: string;
}

/**
 * Generate a real ECDSA P-256 key pair.
 *
 * The protocol package deliberately ships no key generator — the
 * identity package owns that — so the test mints its own.
 */
async function generateTestKey(): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKeySpki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKeySpki,
    keyId: await deriveKeyId(publicKeySpki),
  };
}

function makeEnvelope(overrides: Partial<SignableEnvelope> = {}): SignableEnvelope {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'hello',
    sender: SENDER_ID,
    payload: {
      displayName: 'Alice',
      status: 'available',
      capabilities: { protocolVersion: '0.1' },
    },
    ...overrides,
  };
}

async function sign(
  envelope: SignableEnvelope,
  key: TestKey,
  recipient: string,
): Promise<KsaSignature> {
  return signEnvelope({ envelope, recipient, privateKey: key.privateKey, keyId: key.keyId });
}

describe('envelope signatures — ES256 (Phase A / A2)', () => {
  it('verifies a signature it produced', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it('produces a well-formed ES256 signature', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    expect(signature.alg).toBe('ES256');
    expect(signature.signedFields).toBe('ksa-sig-v1');
    expect(signature.keyId).toBe(key.keyId);
    expect(signature.value).toMatch(/^[A-Za-z0-9_-]+$/);
    // Raw `r || s` is 64 bytes; unpadded base64url of 64 bytes is 86 chars.
    expect(signature.value.length).toBe(86);
    expect(isBase64UrlOfLength(signature.value, ES256_SIGNATURE_BYTES)).toBe(true);
  });

  it('builds the documented LF-terminated signing input', async () => {
    const envelope = makeEnvelope();
    const input = await buildSigningInput(envelope, PEER_ID);
    const records = new TextDecoder().decode(input).split('\n');

    // Every record is LF-terminated, including the last one, so the
    // split leaves a trailing empty string.
    expect(records[records.length - 1]).toBe('');
    expect(records.slice(0, -1)).toHaveLength(9);

    expect(records[0]).toBe('KSA-SIG-V1');
    expect(records[0]).toBe(SIGNING_INPUT_HEADER);
    expect(records[1]).toBe('KSA');
    expect(records[2]).toBe('0.1');
    expect(records[3]).toBe(envelope.messageId);
    expect(records[4]).toBe(envelope.timestamp);
    expect(records[5]).toBe(envelope.type);
    expect(records[6]).toBe(envelope.sender);
    expect(records[7]).toBe(PEER_ID);
    // The last record is the base64url SHA-256 of the canonical payload.
    expect(records[8]).toBe(bytesToBase64Url(await sha256(canonicalizeToBytes(envelope.payload))));
  });

  it('signs an empty recipient for hello, which is sent before the peer is known', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope({ type: 'hello' });
    const signature = await sign(envelope, key, '');

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: '',
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it('fails when the payload is altered', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    const tampered = makeEnvelope({
      payload: { ...(envelope.payload as Record<string, unknown>), displayName: 'Mallory' },
    });

    await expect(
      verifyEnvelopeSignature({
        envelope: tampered,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('fails when the sender is altered', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope: makeEnvelope({ sender: PEER_ID }),
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('fails when the message type is altered', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope: makeEnvelope({ type: 'chat_message' }),
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('fails when the timestamp or the message id is altered', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope: makeEnvelope({ timestamp: '2026-01-01T00:00:01.000Z' }),
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);

    await expect(
      verifyEnvelopeSignature({
        envelope: makeEnvelope({ messageId: '22222222-2222-4222-8222-222222222222' }),
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('binds the signature to one recipient', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    // Signed for the peer — but presented to a different session.
    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: SENDER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);

    // And an empty recipient does not verify a peer-bound signature.
    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: '',
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('fails against a different public key', async () => {
    const key = await generateTestKey();
    const other = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: other.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('fails when the signature value is altered', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    // Flip the first character of the base64url value.
    const flipped = (signature.value[0] === 'A' ? 'B' : 'A') + signature.value.slice(1);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature: { ...signature, value: flipped },
      }),
    ).resolves.toBe(false);
  });

  it('rejects an unknown algorithm or scheme', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature: { ...signature, alg: 'HS256' as unknown as typeof SIGNATURE_ALG },
      }),
    ).resolves.toBe(false);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature: { ...signature, signedFields: 'ksa-sig-v2' as unknown as typeof SIGNING_SCHEME },
      }),
    ).resolves.toBe(false);
  });

  it('rejects a malformed or wrongly-sized signature value', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    for (const value of [
      '',
      'not base64url!!',
      signature.value.slice(0, 40),
      signature.value + 'AA',
    ]) {
      await expect(
        verifyEnvelopeSignature({
          envelope,
          recipient: PEER_ID,
          publicKeySpki: key.publicKeySpki,
          signature: { ...signature, value },
        }),
      ).resolves.toBe(false);
    }
  });

  it('rejects a public key blob that is not a key at all', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();
    const signature = await sign(envelope, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope,
        recipient: PEER_ID,
        publicKeySpki: new Uint8Array([1, 2, 3, 4]),
        signature,
      }),
    ).resolves.toBe(false);
  });

  it('ignores the order the payload properties were written in', async () => {
    const key = await generateTestKey();
    const one = makeEnvelope({
      payload: { a: 1, b: 2, c: { d: 3, e: 4 } },
    });
    const two = makeEnvelope({
      payload: { c: { e: 4, d: 3 }, b: 2, a: 1 },
    });

    const signature = await sign(one, key, PEER_ID);

    await expect(
      verifyEnvelopeSignature({
        envelope: two,
        recipient: PEER_ID,
        publicKeySpki: key.publicKeySpki,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it('produces a fresh signature value each time (ECDSA is randomised)', async () => {
    const key = await generateTestKey();
    const envelope = makeEnvelope();

    const first = await sign(envelope, key, PEER_ID);
    const second = await sign(envelope, key, PEER_ID);

    expect(first.value).not.toBe(second.value);
    for (const signature of [first, second]) {
      await expect(
        verifyEnvelopeSignature({
          envelope,
          recipient: PEER_ID,
          publicKeySpki: key.publicKeySpki,
          signature,
        }),
      ).resolves.toBe(true);
    }
  });

  it('derives the key id from the SPKI blob', async () => {
    const key = await generateTestKey();
    const expected = bytesToBase64Url(await sha256(key.publicKeySpki));
    expect(key.keyId).toBe(expected);
    expect(key.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, unpadded
  });
});
