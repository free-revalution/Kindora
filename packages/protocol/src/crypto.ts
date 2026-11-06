/**
 * WebCrypto helpers for the KSA wire format.
 *
 * Everything here uses platform APIs only (`globalThis.crypto.subtle`) —
 * no third-party crypto dependency. The primitives are:
 *
 *   - ECDSA P-256 / SHA-256 (ES256) — message signatures (A2)
 *   - ECDH P-256                      — session key agreement (A3)
 *   - HKDF-SHA256                     — session key derivation (A3)
 *   - AES-256-GCM                     — session encryption (A3)
 *   - SHA-256                         — digests, key ids
 *
 * Available in browsers, the Tauri webview, jsdom (vitest) and Node 19+.
 */

import { bytesToBase64Url } from './base64';

/** ECDSA / ECDH curve used throughout KSA. */
export const KSA_CURVE = 'P-256';

/** Signature algorithm identifier carried on the wire. */
export const KSA_SIGNATURE_ALG = 'ES256';

/** Byte length of a SHA-256 digest. */
const SHA256_DIGEST_BYTES = 32;

const ECDSA_PARAMS = { name: 'ECDSA', namedCurve: KSA_CURVE } as const;
const ECDH_PARAMS = { name: 'ECDH', namedCurve: KSA_CURVE } as const;

/** Raised when the runtime has no usable WebCrypto implementation. */
export class CryptoUnavailableError extends Error {
  constructor(
    message = 'Web Crypto API unavailable. Kindora requires a runtime with crypto.subtle.',
  ) {
    super(message);
    this.name = 'CryptoUnavailableError';
  }
}

/** The ambient WebCrypto implementation, or throw a typed error. */
export function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new CryptoUnavailableError();
  }
  return c;
}

/** True when the runtime can do asymmetric crypto. */
export function isCryptoAvailable(): boolean {
  try {
    getCrypto();
    return true;
  } catch {
    return false;
  }
}

/** SHA-256 digest. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // The `as BufferSource` casts below are not cosmetic. Since TypeScript
  // 5.7 `Uint8Array` is generic and its default type argument is
  // `ArrayBufferLike`, while the DOM lib types `BufferSource` as
  // `ArrayBufferView<ArrayBuffer> | ArrayBuffer`. A bare `Uint8Array`
  // therefore cannot be *assigned* to a `BufferSource` parameter, even
  // though every WebCrypto implementation accepts it. The assertion is
  // the supported way to say "this view is fine".
  const digest = await getCrypto().subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
}

/**
 * Import a SPKI-encoded ECDSA P-256 public key for verification.
 *
 * `extractable` is `false`: an imported public key is not sensitive, but
 * keeping it non-extractable means a compromised page cannot even copy
 * the key material out of the handle.
 */
export async function importPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return getCrypto().subtle.importKey('spki', spki as BufferSource, ECDSA_PARAMS, false, [
    'verify',
  ]);
}

/**
 * Import a PKCS#8-encoded ECDSA P-256 private key for signing.
 *
 * `extractable` is `false` on purpose: once imported, the key can be
 * *used* to sign but can never be exported again — not by this code, not
 * by anything that manages to reach the handle.
 */
export async function importPrivateKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return getCrypto().subtle.importKey('pkcs8', pkcs8 as BufferSource, ECDSA_PARAMS, false, [
    'sign',
  ]);
}

/**
 * Sign `data` with ECDSA P-256 / SHA-256.
 *
 * WebCrypto emits the **raw `r || s`** form (64 bytes, P1363) — not
 * DER. The wire format uses the raw form so it matches what other
 * implementations (and the `p256` Rust crate, with an explicit
 * conversion) expect.
 */
export async function signEs256(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const signature = await getCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    data as BufferSource,
  );
  return new Uint8Array(signature);
}

/** Verify an ECDSA P-256 / SHA-256 signature over `data`. */
export async function verifyEs256(
  key: CryptoKey,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    return await getCrypto().subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as BufferSource,
      data as BufferSource,
    );
  } catch {
    // A malformed signature makes `verify` throw on some runtimes and
    // return `false` on others. Both mean "not a valid signature".
    return false;
  }
}

/**
 * The key id of an SPKI public key: `base64url(SHA-256(SPKI DER))`.
 *
 * This is the fingerprint a peer can compare out of band (see the
 * pairing-code derivation) and the value that lets a receiver notice a
 * key rotation.
 */
export async function deriveKeyId(spki: Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(spki));
}

/** A freshly generated ECDH P-256 key pair for session key agreement. */
export interface EphemeralKeyPair {
  /** The private half. Never leaves this process. */
  readonly privateKey: CryptoKey;
  /** The public half, SPKI-encoded — this is what goes on the wire. */
  readonly publicKeySpki: Uint8Array;
}

/** Generate an ephemeral ECDH P-256 key pair. */
export async function generateEphemeralKeyPair(): Promise<EphemeralKeyPair> {
  const crypto = getCrypto();
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  return { privateKey: pair.privateKey, publicKeySpki: new Uint8Array(spki) };
}

/** Import an SPKI-encoded ECDH P-256 public key received from a peer. */
export async function importEphemeralPublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return getCrypto().subtle.importKey('spki', spki as BufferSource, ECDH_PARAMS, true, []);
}

/** Run the ECDH exchange and return the 32-byte shared secret. */
export async function deriveSharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Uint8Array> {
  const bits = await getCrypto().subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

/* ------------------------------------------------------------------ */
/* HMAC-SHA256 / HKDF-SHA256                                           */
/* ------------------------------------------------------------------ */

/**
 * HMAC-SHA256 over `data`.
 *
 * Implemented on top of WebCrypto's HMAC rather than `deriveBits`
 * with an `HKDF` algorithm: the WebCrypto HKDF algorithm is not
 * available in every runtime Kindora targets (older WebKit in some
 * Tauri webviews, jsdom without a polyfill). RFC 5869 is short enough
 * to implement directly on HMAC, and doing so keeps one code path for
 * every platform.
 */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const crypto = getCrypto();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, data as BufferSource);
  return new Uint8Array(mac);
}

/**
 * HKDF-SHA256 (RFC 5869).
 *
 *   PRK  = HMAC-SHA256(salt, IKM)
 *   OKM  = T(1) | T(2) | ... ,  T(i) = HMAC-SHA256(PRK, T(i-1) | info | i)
 *
 * An empty `salt` is replaced with `HashLen` zero bytes, as RFC 5869
 * § 2.2 requires.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`hkdfSha256: length must be a positive integer (got ${length}).`);
  }
  if (length > 255 * SHA256_DIGEST_BYTES) {
    throw new RangeError(
      `hkdfSha256: length must be at most ${255 * SHA256_DIGEST_BYTES} bytes (got ${length}).`,
    );
  }
  const effectiveSalt = salt.length === 0 ? new Uint8Array(SHA256_DIGEST_BYTES) : salt;
  const prk = await hmacSha256(effectiveSalt, ikm);

  const okm = new Uint8Array(length);
  // NOTE: the annotation is load-bearing. `new Uint8Array(0)` infers
  // `Uint8Array<ArrayBuffer>`, but `hmacSha256` returns the *bare*
  // `Uint8Array` (= `Uint8Array<ArrayBufferLike>`), which is not
  // assignable to the narrower type under TypeScript 5.7+. We
  // deliberately spell the bare `Uint8Array` here rather than
  // `Uint8Array<ArrayBuffer>`: this package declares
  // `typescript: ^5.6.3`, and the generic parameter only exists from
  // TypeScript 5.7 onwards (open item A-10 in the remediation plan).
  let previous: Uint8Array = new Uint8Array(0);
  let offset = 0;
  for (let counter = 1; offset < length; counter++) {
    const input = new Uint8Array(previous.length + info.length + 1);
    input.set(previous, 0);
    input.set(info, previous.length);
    input[input.length - 1] = counter;
    previous = await hmacSha256(prk, input);
    const take = Math.min(previous.length, length - offset);
    okm.set(previous.subarray(0, take), offset);
    offset += take;
  }
  return okm;
}
