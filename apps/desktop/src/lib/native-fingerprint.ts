/**
 * Pairing fingerprints — Rust-authoritative when Tauri is available (A6 / A10).
 */

import { pairingFingerprintFromPublicKey } from '@kindora/transport';
import { getTauriInvoke, isTauriRuntime } from './tauri-runtime';

export function isNativeFingerprintAvailable(): boolean {
  return isTauriRuntime() && getTauriInvoke() !== null;
}

/** Local Crockford fingerprint derived in Rust when possible. */
export async function deriveLocalFingerprint(
  agentId: string,
  publicKeyB64: string,
): Promise<string> {
  const tauri = getTauriInvoke();
  if (tauri) {
    return tauri.invoke<string>('agent_local_fingerprint', {
      agentId,
      publicKeyB64: publicKeyB64,
    });
  }
  return pairingFingerprintFromPublicKey(agentId, publicKeyB64);
}

/** Compare claimed vs expected fingerprint (Rust normalizes dash/case). */
export async function verifyPeerFingerprint(claimed: string, expected: string): Promise<boolean> {
  const tauri = getTauriInvoke();
  if (tauri) {
    return tauri.invoke<boolean>('agent_verify_peer_fingerprint', { claimed, expected });
  }
  const norm = (s: string) => s.replace(/[\s-]/g, '').toUpperCase();
  return norm(claimed) === norm(expected);
}