/**
 * Rust-authoritative outbound session (P0-2A follow-up).
 *
 * Mirrors `session_*` Tauri commands. Call these before gated signing.
 */

import { getTauriInvoke, isTauriRuntime } from './tauri-runtime';

export function isOutboundSessionAvailable(): boolean {
  return isTauriRuntime() && getTauriInvoke() !== null;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = getTauriInvoke();
  if (!tauri) {
    throw new Error(`${cmd}: Tauri runtime not available.`);
  }
  return tauri.invoke<T>(cmd, args);
}

export async function sessionBindLocal(
  localAgentId: string,
  publicKeyB64?: string,
): Promise<void> {
  if (!isOutboundSessionAvailable()) return;
  await invoke('session_bind_local', {
    localAgentId,
    publicKeyB64: publicKeyB64 ?? null,
  });
}

export async function sessionNotePeer(
  peerAgentId: string,
  peerPublicKeyB64: string,
): Promise<string | null> {
  if (!isOutboundSessionAvailable()) return null;
  return invoke<string>('session_note_peer', {
    peerAgentId,
    peerPublicKeyB64,
  });
}

export async function sessionConfirmPeerFingerprint(claimed: string): Promise<void> {
  if (!isOutboundSessionAvailable()) return;
  await invoke('session_confirm_peer_fingerprint', { claimed });
}

export async function sessionSetMutualConsent(): Promise<void> {
  if (!isOutboundSessionAvailable()) return;
  await invoke('session_set_mutual_consent');
}

export async function sessionAdvanceChat(): Promise<void> {
  if (!isOutboundSessionAvailable()) return;
  await invoke('session_advance_chat');
}

export async function sessionClear(): Promise<void> {
  if (!isOutboundSessionAvailable()) return;
  await invoke('session_clear');
}
