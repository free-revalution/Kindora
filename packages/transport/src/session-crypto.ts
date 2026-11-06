/**
 * Session encryption for KSA (Phase A / A3).
 *
 * ## What this buys
 *
 * The LAN transport is **plaintext TCP**. Anyone on the same Wi-Fi can
 * read every byte of every envelope. This module adds an end-to-end
 * encrypted layer *inside* the envelope, on top of the A2 signatures:
 *
 *   1. The sender signs the **plaintext** envelope (A2). The signature
 *      proves who produced the message and covers the payload digest.
 *   2. The sender then encrypts the **payload** with AES-256-GCM.
 *      The envelope header and the signature travel in the clear, so a
 *      receiver can route the frame and check the signature without
 *      needing the session key first.
 *   3. The header + signature are passed as AES-GCM **additional
 *      authenticated data**, so an attacker cannot swap the header of
 *      one frame onto the ciphertext of another.
 *
 * ## Key agreement
 *
 *   - Each side generates a fresh **ephemeral** ECDH P-256 key pair per
 *     session and offers the public half in its `hello`
 *     (`payload.sessionKeyExchange`).
 *   - The shared secret is the raw ECDH output.
 *   - The session key is
 *     `HKDF-SHA256(ikm = sharedSecret, salt = transcript, info = "KSA-SESSION-V1", len = 32)`.
 *   - The *transcript* is the canonical JSON of both sides'
 *     `(agentId, ephemeralPublicKey)` entries, sorted by agent id, so
 *     both sides derive byte-identical salts without needing to agree
 *     on who is the "host".
 *
 * Ephemeral keys are used on purpose: they give the session forward
 * secrecy. Compromising the long-term identity key later does not
 * decrypt traffic that was already exchanged.
 *
 * ## Nonce
 *
 * AES-GCM needs a unique nonce per encryption under a given key. The
 * nonce here is 12 bytes: a 4-byte big-endian counter followed by 8
 * random bytes generated once per session. The random half removes
 * any chance of two sessions colliding; the counter guarantees
 * uniqueness *within* a session.
 *
 * ## Frame shape
 *
 * ```json
 * {
 *   "protocol": "KSA", "version": "0.1",
 *   "messageId": "...", "timestamp": "...",
 *   "type": "chat_message", "sender": "...",
 *   "signature": { ... },
 *   "nonce": "<base64url>", "ciphertext": "<base64url>"
 * }
 * ```
 *
 * The header fields and the signature are exactly the fields of a
 * normal envelope, so a receiver can compute the AAD without any
 * out-of-band state.
 *
 * See 开发手册.md § 19, and the remediation design in
 * `docs/REMEDIATION_TEST_REPORT.md` § 5.3.
 */

import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeToBytes,
  hkdfSha256,
  validateEnvelope,
  type KsaMessage,
  type KsaSignature,
} from '@kindora/protocol';

/** HKDF `info` string for the KSA session key. */
export const SESSION_KEY_INFO = 'KSA-SESSION-V1';

/** Session key length in bytes (AES-256). */
export const SESSION_KEY_BYTES = 32;

/** AES-GCM nonce length in bytes. */
export const SESSION_NONCE_BYTES = 12;

/** Bytes of the nonce taken from the session-scoped random suffix. */
export const SESSION_NONCE_RANDOM_BYTES = 8;

/** Bytes of the nonce taken from the monotonic send counter. */
export const SESSION_NONCE_COUNTER_BYTES = 4;

/** AES-GCM authentication tag length in bits. */
export const SESSION_TAG_BITS = 128;

/** Raised when session encryption cannot be established or used. */
export class SessionCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionCryptoError';
  }
}

/* ------------------------------------------------------------------ */
/* The cipher                                                          */
/* ------------------------------------------------------------------ */

/** A nonce plus the AES-GCM ciphertext that was sealed under it. */
export interface SealedBytes {
  /** The 12-byte AES-GCM nonce. */
  readonly nonce: Uint8Array;
  /** The ciphertext, with the 16-byte GCM tag appended. */
  readonly ciphertext: Uint8Array;
}

/**
 * A symmetric session cipher.
 *
 * `seal` / `open` take the additional authenticated data explicitly so
 * that the caller — and only the caller — decides what is bound into
 * the tag.
 */
export interface SessionCipher {
  /** Encrypt `plaintext`, binding `aad` into the authentication tag. */
  seal(plaintext: Uint8Array, aad: Uint8Array): Promise<SealedBytes>;
  /** Decrypt `sealed`, verifying the tag over `aad`. */
  open(sealed: SealedBytes, aad: Uint8Array): Promise<Uint8Array>;
  /** Tear the cipher down. Further use throws. */
  destroy(): void;
}

/**
 * Create an AES-256-GCM session cipher from a 32-byte key.
 *
 * The 8 random bytes of the nonce are drawn once, here; the 4-byte
 * counter advances with every `seal`.
 */
export async function createSessionCipher(keyBytes: Uint8Array): Promise<SessionCipher> {
  if (keyBytes.length !== SESSION_KEY_BYTES) {
    throw new SessionCryptoError(
      `createSessionCipher: the session key must be ${SESSION_KEY_BYTES} bytes (got ${keyBytes.length}).`,
    );
  }
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.subtle) {
    throw new SessionCryptoError(
      'createSessionCipher: Web Crypto is unavailable, so the session cannot be encrypted.',
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );

  const randomSuffix = new Uint8Array(SESSION_NONCE_RANDOM_BYTES);
  crypto.getRandomValues(randomSuffix);

  let counter = 0;
  let destroyed = false;

  const nextNonce = (): Uint8Array => {
    if (destroyed) {
      throw new SessionCryptoError('createSessionCipher: the session cipher has been destroyed.');
    }
    if (counter > 0xffffffff) {
      throw new SessionCryptoError(
        'createSessionCipher: the session nonce counter is exhausted; start a new session.',
      );
    }
    const nonce = new Uint8Array(SESSION_NONCE_BYTES);
    const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    view.setUint32(0, counter, false); // big-endian counter
    nonce.set(randomSuffix, SESSION_NONCE_COUNTER_BYTES);
    counter += 1;
    return nonce;
  };

  return {
    async seal(plaintext: Uint8Array, aad: Uint8Array): Promise<SealedBytes> {
      const nonce = nextNonce();
      const sealed = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as BufferSource,
          additionalData: aad as unknown as BufferSource,
          tagLength: SESSION_TAG_BITS,
        },
        key,
        plaintext as unknown as BufferSource,
      );
      return { nonce, ciphertext: new Uint8Array(sealed) };
    },

    async open(sealed: SealedBytes, aad: Uint8Array): Promise<Uint8Array> {
      if (destroyed) {
        throw new SessionCryptoError('createSessionCipher: the session cipher has been destroyed.');
      }
      if (sealed.nonce.length !== SESSION_NONCE_BYTES) {
        throw new SessionCryptoError(
          `open: the nonce must be ${SESSION_NONCE_BYTES} bytes (got ${sealed.nonce.length}).`,
        );
      }
      if (sealed.ciphertext.length < 16) {
        throw new SessionCryptoError('open: the ciphertext is too short to contain a GCM tag.');
      }
      try {
        const opened = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: sealed.nonce as unknown as BufferSource,
            additionalData: aad as unknown as BufferSource,
            tagLength: SESSION_TAG_BITS,
          },
          key,
          sealed.ciphertext as unknown as BufferSource,
        );
        return new Uint8Array(opened);
      } catch {
        throw new SessionCryptoError(
          'open: the session frame failed authentication (wrong key, or the data was altered).',
        );
      }
    },

    destroy(): void {
      destroyed = true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Key agreement                                                       */
/* ------------------------------------------------------------------ */

/** One side's contribution to the session transcript. */
export interface SessionTranscriptEntry {
  /** The agent id of the side that owns the ephemeral key. */
  readonly agentId: string;
  /** Base64url SPKI DER of the ephemeral ECDH public key. */
  readonly ephemeralPublicKey: string;
}

/**
 * The transcript both sides hash into the HKDF salt.
 *
 * The entries are sorted by agent id so that the host and the joiner
 * compute the same bytes without having to agree on a role.
 */
export function computeSessionTranscript(entries: readonly SessionTranscriptEntry[]): Uint8Array {
  if (entries.length !== 2) {
    throw new SessionCryptoError(
      `computeSessionTranscript: expected exactly two entries (got ${entries.length}).`,
    );
  }
  const sorted = [...entries].sort((a, b) =>
    a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0,
  );
  if (sorted[0]?.agentId === sorted[1]?.agentId) {
    throw new SessionCryptoError('computeSessionTranscript: both sides claim the same agent id.');
  }
  return canonicalizeToBytes(
    sorted.map((entry) => ({
      agentId: entry.agentId,
      ephemeralPublicKey: entry.ephemeralPublicKey,
    })),
  );
}

/**
 * Derive the 32-byte session key from the raw ECDH shared secret.
 */
export async function deriveSessionKey(
  sharedSecret: Uint8Array,
  transcript: Uint8Array,
): Promise<Uint8Array> {
  if (sharedSecret.length !== 32) {
    throw new SessionCryptoError(
      `deriveSessionKey: the ECDH shared secret must be 32 bytes (got ${sharedSecret.length}).`,
    );
  }
  return hkdfSha256(
    sharedSecret,
    transcript,
    new TextEncoder().encode(SESSION_KEY_INFO),
    SESSION_KEY_BYTES,
  );
}

/* ------------------------------------------------------------------ */
/* Frames                                                              */
/* ------------------------------------------------------------------ */

/**
 * The wire shape of an encrypted envelope.
 *
 * Everything except `nonce` and `ciphertext` mirrors a normal KSA
 * envelope, so the AAD can be recomputed from the frame alone.
 */
export interface SessionFrame {
  readonly protocol: string;
  readonly version: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly sender: string;
  readonly signature?: KsaSignature;
  /** Base64url 12-byte AES-GCM nonce. */
  readonly nonce: string;
  /** Base64url AES-256-GCM ciphertext of the canonical payload. */
  readonly ciphertext: string;
}

/** True when `value` looks like a session frame rather than a plain envelope. */
export function isSessionFrame(value: unknown): value is SessionFrame {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.nonce === 'string' && typeof obj.ciphertext === 'string';
}

/**
 * The additional authenticated data for a frame: the plaintext header
 * plus the signature.
 *
 * The signature is part of the AAD so that a signature cannot be
 * stripped from a frame without breaking the tag.
 */
export function frameAad(frame: SessionFrame): Uint8Array {
  return canonicalizeToBytes({
    protocol: frame.protocol,
    version: frame.version,
    messageId: frame.messageId,
    timestamp: frame.timestamp,
    type: frame.type,
    sender: frame.sender,
    signature: frame.signature,
  });
}

/**
 * Encrypt an envelope's payload into a session frame.
 *
 * The envelope is validated first so that the plaintext we encrypt is
 * exactly the payload the signature was computed over.
 */
export async function sealEnvelope(
  envelope: KsaMessage,
  cipher: SessionCipher,
): Promise<SessionFrame> {
  const validated = validateEnvelope(envelope);
  const plaintext = canonicalizeToBytes(validated.payload);
  const header = {
    protocol: validated.protocol,
    version: validated.version,
    messageId: validated.messageId,
    timestamp: validated.timestamp,
    type: validated.type,
    sender: validated.sender,
    signature: validated.signature,
  };
  // The AAD is computed from the header *without* the nonce and the
  // ciphertext, so it can be recomputed identically on the far side.
  const aad = canonicalizeToBytes(header);
  const sealed = await cipher.seal(plaintext, aad);
  return {
    ...header,
    nonce: bytesToBase64Url(sealed.nonce),
    ciphertext: bytesToBase64Url(sealed.ciphertext),
  };
}

/**
 * Decrypt a session frame back into a validated envelope.
 */
export async function openFrame(frame: SessionFrame, cipher: SessionCipher): Promise<KsaMessage> {
  const aad = frameAad(frame);
  const plaintext = await cipher.open(
    { nonce: base64UrlToBytes(frame.nonce), ciphertext: base64UrlToBytes(frame.ciphertext) },
    aad,
  );
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch (err) {
    throw new SessionCryptoError(
      `openFrame: the decrypted payload is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  return validateEnvelope({
    protocol: frame.protocol,
    version: frame.version,
    messageId: frame.messageId,
    timestamp: frame.timestamp,
    type: frame.type,
    sender: frame.sender,
    payload,
    ...(frame.signature ? { signature: frame.signature } : {}),
  });
}
