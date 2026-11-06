/**
 * Agent identity — UUID + asymmetric key pair.
 *
 * V0.1 ships a basic ECDSA P-256 key pair. The private key never leaves
 * the local device; only the public key is exchanged with peers.
 *
 * See 开发手册.md § 13.
 */

import type { AgentCapabilities } from '@kindora/protocol';
import { DEFAULT_AGENT_CAPABILITIES, PROTOCOL_VERSION } from '@kindora/protocol';

export interface AgentIdentity {
  /** Random UUID v4. */
  readonly agentId: string;
  /** Base64 (SPKI). Sent to peers. */
  readonly publicKey: string;
  /** Base64 (PKCS8). Local-only; never leaves this device. */
  readonly privateKey: string;
  /** ISO-8601. */
  readonly createdAt: string;
}

/**
 * What the *current runtime* can actually do.
 *
 * Phase A / A4: capabilities used to be a hard-coded object, which let
 * the app advertise things it could not do — most importantly
 * `supportsEncryption: true` while the LAN transport was plaintext
 * TCP and no session key was ever negotiated. Every capability flag
 * now has to be derived from the runtime that is actually in front of
 * us.
 */
export interface RuntimeCapabilities {
  /** `crypto.subtle` is available. */
  readonly cryptoAvailable: boolean;
  /** The long-term private key is reachable, so ES256 signatures can be produced. */
  readonly signingReady: boolean;
  /** ECDH + HKDF + AES-GCM are available, so an encrypted session can be negotiated. */
  readonly sessionEncryptionReady: boolean;
  /** The transport itself is protected by TLS. False in KSA 0.1. */
  readonly transportEncryption: boolean;
  /** A WebRTC DataChannel transport is available. False in KSA 0.1. */
  readonly webRtc: boolean;
}

/**
 * The capability flags an agent may set for itself.
 *
 * The four security flags are deliberately **not** in here: they are
 * derived from the runtime (see `buildRuntimeCapabilities`) and cannot
 * be overridden by a caller, because a caller that could flip them
 * would be able to advertise a capability the agent does not have.
 */
export type CapabilityOverrides = Partial<
  Omit<
    AgentCapabilities,
    | 'supportsMessageSigning'
    | 'supportsSessionEncryption'
    | 'supportsTransportEncryption'
    | 'supportsWebRtc'
  >
>;

/**
 * Build capabilities matching the V0.1 protocol.
 * See 开发手册.md § 15.
 *
 * The security flags default to `false`: an agent must opt in by
 * describing the runtime it actually has.
 */
export function buildCapabilities(overrides: CapabilityOverrides = {}): AgentCapabilities {
  return Object.freeze({
    ...DEFAULT_AGENT_CAPABILITIES,
    ...overrides,
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
  });
}

/**
 * Build the capabilities of an agent from the runtime it is running in.
 *
 * Phase A / A4. The result is frozen and every security flag is a
 * direct function of `runtime` — there is no way to end up advertising
 * a capability the runtime does not have.
 */
export function buildRuntimeCapabilities(
  runtime: RuntimeCapabilities,
  overrides: CapabilityOverrides = {},
): AgentCapabilities {
  return Object.freeze({
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
    supportsMatchAnalysis:
      overrides.supportsMatchAnalysis ?? DEFAULT_AGENT_CAPABILITIES.supportsMatchAnalysis,
    supportsIcebreaker:
      overrides.supportsIcebreaker ?? DEFAULT_AGENT_CAPABILITIES.supportsIcebreaker,
    supportsChatAssist:
      overrides.supportsChatAssist ?? DEFAULT_AGENT_CAPABILITIES.supportsChatAssist,
    supportsMessageSigning: runtime.cryptoAvailable && runtime.signingReady,
    supportsSessionEncryption: runtime.cryptoAvailable && runtime.sessionEncryptionReady,
    supportsTransportEncryption: runtime.transportEncryption,
    supportsWebRtc: runtime.webRtc,
  });
}

const PUBLIC_KEY_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const KEY_USAGES: KeyUsage[] = ['sign', 'verify'];

function getCrypto(): Crypto {
  // Available in modern browsers, jsdom (vitest), Node 19+, and Tauri webview.
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto API unavailable. Kindora requires a runtime with crypto.subtle.');
  }
  return c;
}

/**
 * Create a new agent identity with a fresh key pair.
 *
 * Throws if `crypto.subtle` is unavailable.
 */
export async function createAgentIdentity(): Promise<AgentIdentity> {
  const crypto = getCrypto();

  const agentId = crypto.randomUUID();
  const keyPair = await crypto.subtle.generateKey(PUBLIC_KEY_ALGO, true, KEY_USAGES);

  const [publicSpki, privatePkcs8] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);

  return Object.freeze({
    agentId,
    publicKey: toBase64(publicSpki),
    privateKey: toBase64(privatePkcs8),
    createdAt: new Date().toISOString(),
  });
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // btoa is available in browsers, jsdom, and Node 16+.
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}
