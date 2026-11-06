/**
 * Envelope signer — the bridge between the agent's identity and the
 * transport's wire format (Phase A / A2).
 *
 * The transport layer never sees a private key: it only knows the
 * `EnvelopeSigner` interface. That keeps the OS keychain (where the key
 * actually lives in the shipped app) out of `@kindora/transport`.
 *
 * The private key is imported as **non-extractable**: once it is inside
 * WebCrypto it can be used to sign but never exported again.
 */

import {
  base64ToBytes,
  bytesToBase64Url,
  deriveKeyId,
  importPrivateKey,
  signEs256,
  type EnvelopeSigner,
} from '@kindora/protocol';

export interface SignerIdentity {
  /** The local agent id — the `sender` of every outbound envelope. */
  readonly agentId: string;
  /** Base64 SPKI — the existing wire representation of the public key. */
  readonly publicKey: string;
  /** Base64 PKCS8 — the private key. */
  readonly privateKey: string;
}

/**
 * Build a signer for the local agent.
 *
 * The returned `keyId` is `base64url(SHA-256(SPKI DER))` — the
 * fingerprint a peer compares out of band.
 */
export async function createEnvelopeSigner(identity: SignerIdentity): Promise<EnvelopeSigner> {
  const privateKey = await importPrivateKey(base64ToBytes(identity.privateKey));
  const spki = base64ToBytes(identity.publicKey);
  const keyId = await deriveKeyId(spki);

  return Object.freeze({
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    keyId,
    async sign(input: Uint8Array): Promise<string> {
      return bytesToBase64Url(await signEs256(privateKey, input));
    },
  });
}
