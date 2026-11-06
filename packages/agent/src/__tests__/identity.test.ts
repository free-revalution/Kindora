import { describe, it, expect } from 'vitest';
import { buildCapabilities, buildRuntimeCapabilities, createAgentIdentity } from '../identity';

describe('@kindora/agent — createAgentIdentity', () => {
  it('generates a UUID, key pair, and ISO timestamp', async () => {
    const id = await createAgentIdentity();
    expect(id.agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(typeof id.publicKey).toBe('string');
    expect(typeof id.privateKey).toBe('string');
    expect(id.publicKey.length).toBeGreaterThan(0);
    expect(id.privateKey.length).toBeGreaterThan(0);
    expect(id.publicKey).not.toBe(id.privateKey);
    expect(new Date(id.createdAt).toString()).not.toBe('Invalid Date');
    expect(Object.isFrozen(id)).toBe(true);
  });

  it('produces a different agentId on each call', async () => {
    const a = await createAgentIdentity();
    const b = await createAgentIdentity();
    expect(a.agentId).not.toBe(b.agentId);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe('@kindora/agent — buildCapabilities', () => {
  it('returns the V0.1 default capabilities when called with no overrides', () => {
    const caps = buildCapabilities();
    expect(caps.protocolVersion).toBe('0.1');
    expect(caps.supportsMatchAnalysis).toBe(true);
    expect(caps.supportsIcebreaker).toBe(true);
    expect(caps.supportsChatAssist).toBe(true);
    // Phase A / A4 — the old `supportsEncryption: true` is gone. An agent
    // that has not described its runtime has no security capability.
    expect(caps.supportsMessageSigning).toBe(false);
    expect(caps.supportsSessionEncryption).toBe(false);
    expect(caps.supportsTransportEncryption).toBe(false);
    expect(caps.supportsWebRtc).toBe(false);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it('allows partial overrides but preserves protocolVersion default', () => {
    const caps = buildCapabilities({ supportsChatAssist: false });
    expect(caps.supportsChatAssist).toBe(false);
    expect(caps.supportsMatchAnalysis).toBe(true);
    expect(caps.protocolVersion).toBe('0.1');
  });
});

describe('@kindora/agent — buildRuntimeCapabilities', () => {
  it('derives every security flag from the runtime', () => {
    const caps = buildRuntimeCapabilities({
      cryptoAvailable: true,
      signingReady: true,
      sessionEncryptionReady: true,
      transportEncryption: false,
      webRtc: false,
    });
    expect(caps.supportsMessageSigning).toBe(true);
    expect(caps.supportsSessionEncryption).toBe(true);
    expect(caps.supportsTransportEncryption).toBe(false);
    expect(caps.supportsWebRtc).toBe(false);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it('cannot advertise signing without a private key', () => {
    const caps = buildRuntimeCapabilities({
      cryptoAvailable: true,
      signingReady: false,
      sessionEncryptionReady: true,
      transportEncryption: false,
      webRtc: false,
    });
    expect(caps.supportsMessageSigning).toBe(false);
    expect(caps.supportsSessionEncryption).toBe(true);
  });

  it('cannot advertise anything without WebCrypto', () => {
    const caps = buildRuntimeCapabilities({
      cryptoAvailable: false,
      signingReady: true,
      sessionEncryptionReady: true,
      transportEncryption: true,
      webRtc: true,
    });
    expect(caps.supportsMessageSigning).toBe(false);
    expect(caps.supportsSessionEncryption).toBe(false);
    // These two are not gated on WebCrypto — they describe the transport.
    expect(caps.supportsTransportEncryption).toBe(true);
    expect(caps.supportsWebRtc).toBe(true);
  });
});
