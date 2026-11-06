/**
 * Session encryption (Phase A / A3).
 *
 * The LAN transport is plaintext TCP, so every payload needs its own
 * encryption. These tests exercise the real primitives — ECDH P-256,
 * HKDF-SHA256 and AES-256-GCM through WebCrypto — because a mocked
 * cipher would prove nothing about the wire format.
 *
 * The properties that matter:
 *
 *   1. both sides derive the **same** session key without agreeing on
 *      a role (the transcript is sorted by agent id);
 *   2. the payload does not survive in the clear in the ciphertext;
 *   3. any change to the ciphertext, the nonce, the header or the
 *      signature breaks the authentication tag;
 *   4. the nonce never repeats inside a session.
 *
 * See 开发手册.md § 19 and `docs/REMEDIATION_TEST_REPORT.md` § 5.3.
 */
import { describe, it, expect } from 'vitest';
import {
  bytesToBase64Url,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  importEphemeralPublicKey,
  type KsaChatMessage,
} from '@kindora/protocol';
import {
  SESSION_KEY_BYTES,
  SESSION_KEY_INFO,
  SESSION_NONCE_BYTES,
  SessionCryptoError,
  computeSessionTranscript,
  createSessionCipher,
  deriveSessionKey,
  frameAad,
  isSessionFrame,
  openFrame,
  sealEnvelope,
  type SessionTranscriptEntry,
} from '../session-crypto';

const AGENT_A = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const AGENT_B = '9c858901-8a57-4791-81fe-4c455b099bc9';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chatMessage(text = 'Hello from the other side'): KsaChatMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: '11111111-1111-4111-8111-111111111111',
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'chat_message',
    sender: AGENT_A,
    payload: { text },
  };
}

async function makeKey(): Promise<Uint8Array> {
  return new Uint8Array(32).fill(7);
}

describe('session cipher — AES-256-GCM', () => {
  it('rejects a key that is not 32 bytes', async () => {
    await expect(createSessionCipher(new Uint8Array(16))).rejects.toThrow(SessionCryptoError);
    await expect(createSessionCipher(new Uint8Array(31))).rejects.toThrow(SessionCryptoError);
    await expect(createSessionCipher(new Uint8Array(33))).rejects.toThrow(SessionCryptoError);
  });

  it('round-trips a plaintext', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const plaintext = encoder.encode('the quick brown fox');
    const aad = encoder.encode('header');

    const sealed = await cipher.seal(plaintext, aad);
    const opened = await cipher.open(sealed, aad);

    expect(decoder.decode(opened)).toBe('the quick brown fox');
  });

  it('does not leave the plaintext in the ciphertext', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const plaintext = encoder.encode('a very secret sentence');
    const sealed = await cipher.seal(plaintext, encoder.encode('aad'));

    expect(decoder.decode(sealed.ciphertext)).not.toContain('secret');
    expect(sealed.ciphertext.length).toBeGreaterThan(plaintext.length); // + GCM tag
  });

  it('rejects a tampered ciphertext', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const aad = encoder.encode('aad');
    const sealed = await cipher.seal(encoder.encode('payload'), aad);

    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;

    await expect(cipher.open({ ...sealed, ciphertext: tampered }, aad)).rejects.toThrow(
      SessionCryptoError,
    );
  });

  it('rejects a tampered additional authenticated data', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const sealed = await cipher.seal(encoder.encode('payload'), encoder.encode('aad'));

    await expect(cipher.open(sealed, encoder.encode('other'))).rejects.toThrow(SessionCryptoError);
  });

  it('rejects a swapped nonce', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const aad = encoder.encode('aad');
    const sealed = await cipher.seal(encoder.encode('payload'), aad);

    const other = await cipher.seal(encoder.encode('other payload'), aad);
    await expect(cipher.open({ ...sealed, nonce: other.nonce }, aad)).rejects.toThrow(
      SessionCryptoError,
    );
  });

  it('never repeats a nonce inside a session', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const aad = encoder.encode('aad');

    const nonces: string[] = [];
    for (let i = 0; i < 16; i++) {
      const sealed = await cipher.seal(encoder.encode(`message ${i}`), aad);
      nonces.push(bytesToBase64Url(sealed.nonce));
    }
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('builds the nonce as a big-endian counter plus a session random suffix', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const aad = encoder.encode('aad');

    const first = await cipher.seal(encoder.encode('one'), aad);
    const second = await cipher.seal(encoder.encode('two'), aad);

    expect(first.nonce).toHaveLength(SESSION_NONCE_BYTES);
    expect(second.nonce).toHaveLength(SESSION_NONCE_BYTES);

    const firstCounter = new DataView(
      first.nonce.buffer,
      first.nonce.byteOffset,
      first.nonce.byteLength,
    ).getUint32(0, false);
    const secondCounter = new DataView(
      second.nonce.buffer,
      second.nonce.byteOffset,
      second.nonce.byteLength,
    ).getUint32(0, false);

    expect(firstCounter).toBe(0);
    expect(secondCounter).toBe(1);

    // The trailing 8 bytes are random once per session and stay the
    // same for the whole session.
    expect(first.nonce.slice(4)).toEqual(second.nonce.slice(4));
  });

  it('uses a different random suffix in a different session', async () => {
    const key = await makeKey();
    const a = await createSessionCipher(key);
    const b = await createSessionCipher(key);

    const sealedA = await a.seal(encoder.encode('x'), encoder.encode('aad'));
    const sealedB = await b.seal(encoder.encode('x'), encoder.encode('aad'));

    expect(sealedA.nonce.slice(4)).not.toEqual(sealedB.nonce.slice(4));
  });

  it('refuses to work after destroy()', async () => {
    const cipher = await createSessionCipher(await makeKey());
    cipher.destroy();
    await expect(cipher.seal(encoder.encode('x'), encoder.encode('aad'))).rejects.toThrow(
      SessionCryptoError,
    );
  });

  it('rejects a malformed nonce or a truncated ciphertext', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const aad = encoder.encode('aad');
    const sealed = await cipher.seal(encoder.encode('payload'), aad);

    await expect(
      cipher.open({ nonce: new Uint8Array(8), ciphertext: sealed.ciphertext }, aad),
    ).rejects.toThrow(SessionCryptoError);
    await expect(
      cipher.open({ nonce: sealed.nonce, ciphertext: new Uint8Array(4) }, aad),
    ).rejects.toThrow(SessionCryptoError);
  });
});

describe('session transcript', () => {
  const entries: SessionTranscriptEntry[] = [
    { agentId: AGENT_A, ephemeralPublicKey: 'AAAA' },
    { agentId: AGENT_B, ephemeralPublicKey: 'BBBB' },
  ];

  it('does not depend on the order the entries are supplied in', () => {
    const one = computeSessionTranscript(entries);
    const two = computeSessionTranscript([...entries].reverse());
    expect(one).toEqual(two);
    expect(decoder.decode(one)).toContain(AGENT_A);
    expect(decoder.decode(one)).toContain(AGENT_B);
  });

  it('sorts the entries by agent id', () => {
    const transcript = decoder.decode(computeSessionTranscript(entries));
    expect(transcript.indexOf(AGENT_A)).toBeLessThan(transcript.indexOf(AGENT_B));
  });

  it('requires exactly two entries', () => {
    expect(() => computeSessionTranscript([])).toThrow(SessionCryptoError);
    expect(() => computeSessionTranscript([entries[0] as SessionTranscriptEntry])).toThrow(
      SessionCryptoError,
    );
    expect(() =>
      computeSessionTranscript([
        ...entries,
        { agentId: '00000000-0000-4000-8000-000000000000', ephemeralPublicKey: 'CCCC' },
      ]),
    ).toThrow(SessionCryptoError);
  });

  it('rejects two sides claiming the same agent id', () => {
    expect(() =>
      computeSessionTranscript([
        { agentId: AGENT_A, ephemeralPublicKey: 'AAAA' },
        { agentId: AGENT_A, ephemeralPublicKey: 'BBBB' },
      ]),
    ).toThrow(SessionCryptoError);
  });
});

describe('session key derivation', () => {
  it('rejects a shared secret that is not 32 bytes', async () => {
    await expect(deriveSessionKey(new Uint8Array(16), new Uint8Array(32))).rejects.toThrow(
      SessionCryptoError,
    );
  });

  it('produces a 32-byte key', async () => {
    const key = await deriveSessionKey(new Uint8Array(32), new Uint8Array(32));
    expect(key).toHaveLength(SESSION_KEY_BYTES);
    expect(SESSION_KEY_INFO).toBe('KSA-SESSION-V1');
  });

  it('is deterministic', async () => {
    const secret = new Uint8Array(32).fill(3);
    const transcript = new Uint8Array(16).fill(9);
    const one = await deriveSessionKey(secret, transcript);
    const two = await deriveSessionKey(secret, transcript);
    expect(one).toEqual(two);
  });

  it('changes when the transcript changes', async () => {
    const secret = new Uint8Array(32).fill(3);
    const one = await deriveSessionKey(secret, new Uint8Array(16).fill(9));
    const two = await deriveSessionKey(secret, new Uint8Array(16).fill(10));
    expect(one).not.toEqual(two);
  });

  it('gives both sides the same key, with no role agreement', async () => {
    // A real ECDH exchange: the two sides never talk about who is the
    // host, they just agree on the transcript contents.
    const a = await generateEphemeralKeyPair();
    const b = await generateEphemeralKeyPair();

    const secretA = await deriveSharedSecret(
      a.privateKey,
      await importEphemeralPublicKey(b.publicKeySpki),
    );
    const secretB = await deriveSharedSecret(
      b.privateKey,
      await importEphemeralPublicKey(a.publicKeySpki),
    );
    expect(secretA).toEqual(secretB);

    const transcriptA = computeSessionTranscript([
      { agentId: AGENT_A, ephemeralPublicKey: bytesToBase64Url(a.publicKeySpki) },
      { agentId: AGENT_B, ephemeralPublicKey: bytesToBase64Url(b.publicKeySpki) },
    ]);
    const transcriptB = computeSessionTranscript([
      { agentId: AGENT_B, ephemeralPublicKey: bytesToBase64Url(b.publicKeySpki) },
      { agentId: AGENT_A, ephemeralPublicKey: bytesToBase64Url(a.publicKeySpki) },
    ]);
    expect(transcriptA).toEqual(transcriptB);

    const keyA = await deriveSessionKey(secretA, transcriptA);
    const keyB = await deriveSessionKey(secretB, transcriptB);
    expect(keyA).toEqual(keyB);

    // And the key really does open the other side's ciphertext.
    const cipherA = await createSessionCipher(keyA);
    const cipherB = await createSessionCipher(keyB);
    const sealed = await cipherA.seal(encoder.encode('hello'), encoder.encode('aad'));
    const opened = await cipherB.open(sealed, encoder.encode('aad'));
    expect(decoder.decode(opened)).toBe('hello');
  });
});

describe('session frames', () => {
  it('round-trips an envelope through a frame', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const envelope = chatMessage();

    const frame = await sealEnvelope(envelope, cipher);
    const opened = await openFrame(frame, cipher);

    expect(opened.type).toBe('chat_message');
    expect(opened.sender).toBe(AGENT_A);
    expect(opened.messageId).toBe(envelope.messageId);
    if (opened.type !== 'chat_message') throw new Error('expected a chat_message');
    expect(opened.payload.text).toBe(envelope.payload.text);
  });

  it('keeps the header in the clear and the payload out of it', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const frame = await sealEnvelope(chatMessage('a secret sentence'), cipher);

    expect(frame.protocol).toBe('KSA');
    expect(frame.version).toBe('0.1');
    expect(frame.type).toBe('chat_message');
    expect(frame.sender).toBe(AGENT_A);
    expect(frame.messageId).toBe('11111111-1111-4111-8111-111111111111');

    expect(frame.ciphertext).not.toContain('secret');
  });

  it('produces a frame that is recognisable as a session frame', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const frame = await sealEnvelope(chatMessage(), cipher);

    expect(isSessionFrame(frame)).toBe(true);
    expect(isSessionFrame(chatMessage())).toBe(false);
    expect(isSessionFrame(null)).toBe(false);
    expect(isSessionFrame('frame')).toBe(false);
    expect(isSessionFrame({ nonce: 1 })).toBe(false);
  });

  it('binds the header into the authentication tag', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const frame = await sealEnvelope(chatMessage(), cipher);

    // The sender field is in the AAD, so it cannot be swapped.
    const swapped = { ...frame, sender: AGENT_B };
    await expect(openFrame(swapped, cipher)).rejects.toThrow(SessionCryptoError);

    const retyped = { ...frame, type: 'block' };
    await expect(openFrame(retyped, cipher)).rejects.toThrow(SessionCryptoError);
  });

  it('binds the signature into the authentication tag', async () => {
    const cipher = await createSessionCipher(await makeKey());
    // A well-formed (but fake) signature block — the frame layer only
    // needs it to be present and stable, not cryptographically valid.
    const signature = {
      alg: 'ES256' as const,
      signedFields: 'ksa-sig-v1' as const,
      keyId: 'A'.repeat(43),
      value: 'B'.repeat(86),
    };
    const frame = await sealEnvelope({ ...chatMessage(), signature }, cipher);
    expect(frame.signature).toBeDefined();

    // A signature that is stripped breaks the frame.
    const stripped = { ...frame, signature: undefined };
    await expect(openFrame(stripped, cipher)).rejects.toThrow(SessionCryptoError);

    // A signature that is swapped breaks the frame.
    const forged = { ...frame, signature: { ...signature, value: 'C'.repeat(86) } };
    await expect(openFrame(forged, cipher)).rejects.toThrow(SessionCryptoError);
  });

  it('computes the AAD from the frame alone', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const frame = await sealEnvelope(chatMessage(), cipher);

    const aad = frameAad(frame);
    expect(aad.length).toBeGreaterThan(0);

    const changed = frameAad({ ...frame, sender: AGENT_B });
    expect(changed).not.toEqual(aad);
  });

  it('cannot be opened with a different session key', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const other = await createSessionCipher(new Uint8Array(32).fill(8));
    const frame = await sealEnvelope(chatMessage(), cipher);

    await expect(openFrame(frame, other)).rejects.toThrow(SessionCryptoError);
  });

  it('refuses to seal an envelope that does not validate', async () => {
    const cipher = await createSessionCipher(await makeKey());
    const broken = { ...chatMessage(), messageId: 'not-a-uuid' };
    await expect(sealEnvelope(broken, cipher)).rejects.toThrow();
  });
});
