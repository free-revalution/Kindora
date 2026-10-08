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
 * Build capabilities matching the V0.1 protocol.
 * See 开发手册.md § 15.
 */
export function buildCapabilities(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return Object.freeze({
    ...DEFAULT_AGENT_CAPABILITIES,
    ...overrides,
    protocolVersion: overrides.protocolVersion ?? PROTOCOL_VERSION,
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
