import { describe, it, expect } from 'vitest';
import { buildCapabilities, createAgentIdentity } from '../identity';

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
    expect(caps.supportsEncryption).toBe(true);
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it('allows partial overrides but preserves protocolVersion default', () => {
    const caps = buildCapabilities({ supportsChatAssist: false });
    expect(caps.supportsChatAssist).toBe(false);
    expect(caps.supportsMatchAnalysis).toBe(true);
    expect(caps.protocolVersion).toBe('0.1');
  });
});
