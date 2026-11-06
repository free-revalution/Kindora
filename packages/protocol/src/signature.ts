/**
 * KSA message signatures (Phase A / A2).
 *
 * A KSA envelope proves *who* sent it. Without a signature the `sender`
 * field is just a self-asserted UUID — anything on the wire can claim
 * to be anyone.
 *
 * ## Signing input
 *
 * The signature covers a deterministic byte string built from the
 * envelope's header fields plus a digest of the payload:
 *
 * ```text
 * KSA-SIG-V1\n
 * <protocol>\n
 * <version>\n
 * <messageId>\n
 * <timestamp>\n
 * <type>\n
 * <sender>\n
 * <recipient>\n
 * <base64url(SHA-256(JCS(payload)))>\n
 * ```
 *
 * Every record is LF-terminated, so the input is unambiguous: no field
 * can contain a newline, and no field can be shifted into its
 * neighbour's position.
 *
 * `JCS` is RFC 8785 canonical JSON (`canonical-json.ts`). The payload
 * digest is taken over the **validated** payload — the same shape the
 * receiver ends up with after `validateEnvelope` — so both sides hash
 * identical bytes even though the validator drops unknown fields,
 * filters invalid enum members and forces the five boundary booleans.
 *
 * `recipient` binds the message to the session: the sender signs with
 * the **peer's** agent id, the receiver verifies against its **own**
 * agent id. A signature therefore cannot be lifted out of one pairing
 * and replayed into another. The one exception is `hello`, which is sent
 * before the peer is known — it signs with an empty recipient.
 *
 * ## Algorithm
 *
 * ECDSA P-256 with SHA-256, identified on the wire as `ES256`. The
 * signature value is the raw `r || s` form (64 bytes, P1363) encoded as
 * unpadded base64url — the same shape WebCrypto produces natively.
 *
 * See 开发手册.md § 13, and the remediation design in
 * `docs/REMEDIATION_TEST_REPORT.md` § 5.2.
 */

import { bytesToBase64Url, base64UrlToBytes } from './base64';
import { canonicalizeToBytes } from './canonical-json';
import { importPublicKey, sha256, signEs256, verifyEs256 } from './crypto';

/** Signature algorithm identifier carried on the wire. */
export const SIGNATURE_ALG = 'ES256';

/** Signature scheme version — bump when the input format changes. */
export const SIGNING_SCHEME = 'ksa-sig-v1';

/** First record of the signing input. */
export const SIGNING_INPUT_HEADER = 'KSA-SIG-V1';

/** Byte length of a raw P-256 ECDSA signature (`r || s`). */
export const ES256_SIGNATURE_BYTES = 64;

/** Byte length of a SHA-256 digest (and therefore of a key id). */
export const SHA256_BYTES = 32;

/** A detached signature over a KSA envelope. */
export interface KsaSignature {
  /** Always `ES256` for now. */
  readonly alg: typeof SIGNATURE_ALG;
  /** `base64url(SHA-256(SPKI DER))` of the signer's public key. */
  readonly keyId: string;
  /** `base64url(raw r || s)` — 64 bytes. */
  readonly value: string;
  /** The scheme the signature was produced under. */
  readonly signedFields: typeof SIGNING_SCHEME;
}

/**
 * The structural subset of a KSA envelope that a signature covers.
 *
 * Declared here rather than imported from `envelope.ts` so that the
 * envelope module can depend on this one without a cycle.
 */
export interface SignableEnvelope {
  readonly protocol: string;
  readonly version: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly sender: string;
  /** The **validated** payload. */
  readonly payload: unknown;
}

/** Build the exact bytes that get signed. */
export async function buildSigningInput(
  envelope: SignableEnvelope,
  recipient: string,
): Promise<Uint8Array> {
  const digest = await sha256(canonicalizeToBytes(envelope.payload));
  const records = [
    SIGNING_INPUT_HEADER,
    envelope.protocol,
    envelope.version,
    envelope.messageId,
    envelope.timestamp,
    envelope.type,
    envelope.sender,
    recipient,
    bytesToBase64Url(digest),
  ];
  // Every record is LF-terminated, including the last one.
  return new TextEncoder().encode(records.map((r) => `${r}\n`).join(''));
}

export interface SignEnvelopeParams {
  /** The envelope to sign. Its payload must already be validated. */
  readonly envelope: SignableEnvelope;
  /** The peer's agent id — binds the signature to this session. */
  readonly recipient: string;
  /** The signer's private key (non-extractable). */
  readonly privateKey: CryptoKey;
  /** The signer's key id. */
  readonly keyId: string;
}

/** Produce a detached signature for an envelope. */
export async function signEnvelope(params: SignEnvelopeParams): Promise<KsaSignature> {
  const input = await buildSigningInput(params.envelope, params.recipient);
  const raw = await signEs256(params.privateKey, input);
  return Object.freeze({
    alg: SIGNATURE_ALG,
    keyId: params.keyId,
    value: bytesToBase64Url(raw),
    signedFields: SIGNING_SCHEME,
  });
}

export interface VerifyEnvelopeParams {
  /** The received envelope. Its payload must already be validated. */
  readonly envelope: SignableEnvelope;
  /** The local agent id — the recipient the sender must have used. */
  readonly recipient: string;
  /** The signer's public key (SPKI DER). */
  readonly publicKeySpki: Uint8Array;
  /** The detached signature as it arrived on the wire. */
  readonly signature: KsaSignature;
}

/**
 * Verify a detached signature.
 *
 * Returns `false` — never throws — for every failure mode: a wrong
 * algorithm, an unknown scheme, a malformed value, a key that does not
 * match, or a payload that was altered in flight.
 */
export async function verifyEnvelopeSignature(params: VerifyEnvelopeParams): Promise<boolean> {
  if (params.signature.alg !== SIGNATURE_ALG) return false;
  if (params.signature.signedFields !== SIGNING_SCHEME) return false;
  if (!isBase64UrlOfLength(params.signature.value, ES256_SIGNATURE_BYTES)) return false;

  let raw: Uint8Array;
  try {
    raw = base64UrlToBytes(params.signature.value);
  } catch {
    return false;
  }

  const input = await buildSigningInput(params.envelope, params.recipient);

  // Import the key lazily so a malformed SPKI blob is a `false`, not a
  // thrown exception that could escape into the message pump.
  let key: CryptoKey;
  try {
    key = await importPublicKey(params.publicKeySpki);
  } catch {
    return false;
  }
  return verifyEs256(key, input, raw);
}

/** True when `text` is unpadded base64url decoding to exactly `byteLength` bytes. */
export function isBase64UrlOfLength(text: string, byteLength: number): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return false;
  try {
    return base64UrlToBytes(text).length === byteLength;
  } catch {
    return false;
  }
}

/**
 * Something that can sign envelopes on behalf of the local agent.
 *
 * Implemented by `@kindora/agent` (WebCrypto) and by the desktop app
 * (which delegates to the OS keychain). The transport layer only ever
 * sees this interface, so it never needs to know where the private key
 * lives.
 */
export interface EnvelopeSigner {
  /** The local agent id — the `sender` of every outbound envelope. */
  readonly agentId: string;
  /** SPKI public key, standard base64 — the existing wire representation. */
  readonly publicKey: string;
  /** `base64url(SHA-256(SPKI DER))`. */
  readonly keyId: string;
  /** Sign the given bytes, returning unpadded base64url `r || s`. */
  sign(input: Uint8Array): Promise<string>;
}

/**
 * Something that can check a peer's signature.
 *
 * Kept separate from `EnvelopeSigner` because verification never needs
 * secret material and can be done for any peer.
 */
export interface EnvelopeVerifier {
  /**
   * @param publicKeySpki the signer's SPKI public key
   * @param input          the exact bytes that were signed
   * @param signatureValue unpadded base64url `r || s`
   */
  verify(publicKeySpki: Uint8Array, input: Uint8Array, signatureValue: string): Promise<boolean>;
}
