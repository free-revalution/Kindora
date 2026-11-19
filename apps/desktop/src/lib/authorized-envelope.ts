/**
 * Authorized envelope signing via Rust `agent_sign_envelope` (P0-2A / A8 / A10).
 *
 * WebView only submits `{ typeName, payload }`. Phase / trust / consent /
 * local identity live in Rust `AppState.outbound` and are mutated by the
 * `session_*` commands in `outbound-session.ts`.
 */

import type { KsaMessage, KsaSignature } from '@kindora/protocol';
import { SIGNATURE_ALG, SIGNING_SCHEME, validateEnvelope } from '@kindora/protocol';
import type { AuthorizedEnvelopeSignFn } from '@kindora/transport';
import type { SignedEnvelopeParts } from './authorized-envelope-types';
import { getTauriInvoke, isTauriRuntime } from './tauri-runtime';
import { toAgentKeyError } from './tauri-agent-keychain';

export type { SignedEnvelopeParts } from './authorized-envelope-types';

/** @deprecated Kept for UI that still mirrors local hints; Rust owns auth. */
export interface EnvelopeAuthState {
  phase: string;
  peerTrust: string;
  consentLocal: boolean;
  consentPeer: boolean;
  localAgentId: string;
  localKeyId?: string;
}

export interface SignEnvelopeAuthorizedParams {
  readonly typeName: string;
  readonly payload: unknown;
}

/** Invoke Rust `agent_sign_envelope` when running under Tauri. */
export async function signEnvelopeAuthorized(
  params: SignEnvelopeAuthorizedParams,
): Promise<SignedEnvelopeParts> {
  const tauri = getTauriInvoke();
  if (!tauri) {
    throw new Error('signEnvelopeAuthorized: Tauri runtime not available.');
  }
  try {
    return await tauri.invoke<SignedEnvelopeParts>('agent_sign_envelope', {
      typeName: params.typeName,
      payload: params.payload,
    });
  } catch (err: unknown) {
    throw toAgentKeyError(err);
  }
}

export function isAuthorizedEnvelopeSigningAvailable(): boolean {
  return isTauriRuntime() && getTauriInvoke() !== null;
}

/** Map Rust wire parts into a validated `KsaMessage`. */
export function signedPartsToKsaMessage(parts: SignedEnvelopeParts): KsaMessage {
  const rawSig = parts.signature as {
    alg?: string;
    signedFields?: string;
    keyId?: string;
    value?: string;
  };
  if (rawSig.alg !== SIGNATURE_ALG || rawSig.signedFields !== SIGNING_SCHEME) {
    throw new Error(
      `signedPartsToKsaMessage: unexpected signature metadata (alg=${String(rawSig.alg)}, signedFields=${String(rawSig.signedFields)})`,
    );
  }
  if (typeof rawSig.keyId !== 'string' || typeof rawSig.value !== 'string') {
    throw new Error('signedPartsToKsaMessage: signature keyId/value missing');
  }
  const signature: KsaSignature = {
    alg: SIGNATURE_ALG,
    signedFields: SIGNING_SCHEME,
    keyId: rawSig.keyId,
    value: rawSig.value,
  };
  return validateEnvelope({
    protocol: parts.protocol,
    version: parts.version,
    messageId: parts.messageId,
    timestamp: parts.timestamp,
    type: parts.typeName,
    sender: parts.sender,
    payload: parts.payload,
    signature,
  });
}

/** Local mirror only — Rust `session_bind_local` is authoritative. */
export function createEnvelopeAuthState(
  localAgentId: string,
  localKeyId?: string,
): EnvelopeAuthState {
  return {
    phase: 'hello_exchange',
    peerTrust: 'provisional',
    consentLocal: false,
    consentPeer: false,
    localAgentId,
    localKeyId,
  };
}

/**
 * Build a PairingSession `authorizedSign` hook (type + payload only).
 */
export function createAuthorizedSignFn(
  _state?: EnvelopeAuthState,
): AuthorizedEnvelopeSignFn {
  return async ({ typeName, payload }) => {
    const parts = await signEnvelopeAuthorized({ typeName, payload });
    return signedPartsToKsaMessage(parts);
  };
}

/** Local mirror after Rust `session_confirm_peer_fingerprint`. */
export function markPeerFingerprintVerified(state: EnvelopeAuthState): void {
  state.peerTrust = 'verified';
  if (state.phase === 'hello_exchange' || state.phase === 'discovering') {
    state.phase = 'verified';
  }
}

/** Local mirror after Rust `session_set_mutual_consent`. */
export function markMutualConsent(state: EnvelopeAuthState): void {
  state.consentLocal = true;
  state.consentPeer = true;
  state.phase = 'consent';
}

/** Local mirror after Rust `session_advance_chat`. */
export function markChatPhase(state: EnvelopeAuthState): void {
  state.phase = 'chat';
}
