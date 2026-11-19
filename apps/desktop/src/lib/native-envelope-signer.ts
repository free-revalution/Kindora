/**
 * Native envelope identity metadata (P0-2A / D4).
 *
 * Outbound signing under Tauri goes through `authorizedSign` →
 * `agent_sign_envelope`. This module only builds an `EnvelopeSigner`
 * shape for keyId / capability reporting. Calling `sign()` throws —
 * the arbitrary-byte `agent_sign` IPC was removed from the WebView.
 */

import {
  base64ToBytes,
  deriveKeyId,
  type EnvelopeSigner,
} from '@kindora/protocol';
import { getTauriInvoke, isTauriRuntime } from './tauri-runtime';

export interface NativeSignerIdentity {
  readonly agentId: string;
  readonly publicKey: string;
}

/** True when the desktop app can use Rust-gated envelope signing. */
export function isNativeSigningAvailable(): boolean {
  return isTauriRuntime() && getTauriInvoke() !== null;
}

/**
 * Build an `EnvelopeSigner` that **refuses** byte-level `sign()`.
 * PairingSession must use `authorizedSign` when this is present.
 */
export async function createNativeEnvelopeSigner(
  identity: NativeSignerIdentity,
): Promise<EnvelopeSigner> {
  if (!isNativeSigningAvailable()) {
    throw new Error('createNativeEnvelopeSigner: Tauri runtime not available.');
  }
  const spki = base64ToBytes(identity.publicKey);
  const keyId = await deriveKeyId(spki);

  return Object.freeze({
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    keyId,
    async sign(_input: Uint8Array): Promise<string> {
      throw new Error(
        'native EnvelopeSigner.sign() is disabled (D4). Use authorizedSign → agent_sign_envelope.',
      );
    },
  });
}

export const createAuthorizedEnvelopeSigner = createNativeEnvelopeSigner;
