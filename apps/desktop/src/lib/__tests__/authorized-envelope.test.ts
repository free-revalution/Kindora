import { describe, it, expect } from 'vitest';
import {
  createEnvelopeAuthState,
  isAuthorizedEnvelopeSigningAvailable,
  markChatPhase,
  markMutualConsent,
  markPeerFingerprintVerified,
  signedPartsToKsaMessage,
} from '../authorized-envelope';

const CAPS = {
  protocolVersion: '0.1',
  supportsMatchAnalysis: true,
  supportsIcebreaker: true,
  supportsChatAssist: true,
  supportsMessageSigning: true,
  supportsSessionEncryption: true,
  supportsTransportEncryption: false,
  supportsWebRtc: false,
};

describe('authorized-envelope (A10)', () => {
  it('reports authorised signing unavailable outside Tauri', () => {
    expect(isAuthorizedEnvelopeSigningAvailable()).toBe(false);
  });

  it('advances auth state through fingerprint → consent → chat', () => {
    const state = createEnvelopeAuthState('agent-1', 'kid');
    expect(state.phase).toBe('hello_exchange');
    expect(state.peerTrust).toBe('provisional');
    markPeerFingerprintVerified(state);
    expect(state.peerTrust).toBe('verified');
    expect(state.phase).toBe('verified');
    markMutualConsent(state);
    expect(state.consentLocal).toBe(true);
    expect(state.consentPeer).toBe(true);
    expect(state.phase).toBe('consent');
    markChatPhase(state);
    expect(state.phase).toBe('chat');
  });

  it('maps Rust signed parts into a KsaMessage', () => {
    // 32-byte digest → 43-char unpadded base64url keyId.
    const keyId = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    // 64-byte r||s → 86-char unpadded base64url.
    const value =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const msg = signedPartsToKsaMessage({
      protocol: 'KSA',
      version: '0.1',
      messageId: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-01-01T00:00:00.000Z',
      typeName: 'hello',
      sender: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipient: '',
      payload: {
        displayName: 'Ada',
        publicKey: 'AAAA',
        capabilities: CAPS,
      },
      signature: {
        alg: 'ES256',
        signedFields: 'ksa-sig-v1',
        keyId,
        value,
      },
    });
    expect(msg.type).toBe('hello');
    expect(msg.signature?.keyId).toBe(keyId);
  });
});
