import { describe, it, expect } from 'vitest';
import { decodeQrPayload, encodeQrPayload, isKindoraPairUrl } from '../index';

const AGENT = '11111111-2222-4333-8444-555555555555';

describe('@kindora/transport — qr-payload', () => {
  it('encodeQrPayload → decodeQrPayload round-trips', () => {
    const url = encodeQrPayload({ code: 'ABCDEF', agentId: AGENT, protocolVersion: '0.1' });
    const back = decodeQrPayload(url);
    expect(back).toEqual({ code: 'ABCDEF', agentId: AGENT, protocolVersion: '0.1' });
  });

  it('encoded URL starts with kindora://pair?', () => {
    const url = encodeQrPayload({ code: 'ABCDEF', agentId: AGENT, protocolVersion: '0.1' });
    expect(url.startsWith('kindora://pair?')).toBe(true);
    expect(isKindoraPairUrl(url)).toBe(true);
  });

  it('lowercases the agent id in the decoded payload', () => {
    const upper = AGENT.toUpperCase();
    const url = encodeQrPayload({ code: 'ABCDEF', agentId: upper, protocolVersion: '0.1' });
    const back = decodeQrPayload(url);
    expect(back?.agentId).toBe(AGENT);
  });

  it('accepts lowercase codes and normalises them', () => {
    const url = encodeQrPayload({ code: 'abcdef', agentId: AGENT, protocolVersion: '0.1' });
    const back = decodeQrPayload(url);
    expect(back?.code).toBe('ABCDEF');
  });

  it('rejects non-Kindora URLs', () => {
    expect(isKindoraPairUrl('https://example.com')).toBe(false);
    expect(decodeQrPayload('https://example.com')).toBeNull();
    expect(decodeQrPayload('kindora://other?c=A&a=B')).toBeNull();
  });

  it('rejects malformed QR payloads', () => {
    expect(decodeQrPayload('kindora://pair?c=ABCDEF')).toBeNull(); // missing a, v
    expect(decodeQrPayload('kindora://pair?c=ILOU&a=' + AGENT + '&v=0.1')).toBeNull(); // bad code
    expect(decodeQrPayload('kindora://pair?c=ABCDEF&a=not-a-uuid&v=0.1')).toBeNull(); // bad agent
  });

  it('ignores unknown query params for forward compatibility', () => {
    const url = 'kindora://pair?c=ABCDEF&a=' + AGENT + '&v=0.1&extra=ignored&another=foo';
    expect(decodeQrPayload(url)).toEqual({
      code: 'ABCDEF',
      agentId: AGENT,
      protocolVersion: '0.1',
    });
  });

  it('encodeQrPayload validates the code shape and agent id', () => {
    expect(() =>
      encodeQrPayload({ code: 'ILOU!!', agentId: AGENT, protocolVersion: '0.1' }),
    ).toThrow(/code/i);
    expect(() =>
      encodeQrPayload({ code: 'ABCDEF', agentId: 'not-a-uuid', protocolVersion: '0.1' }),
    ).toThrow(/agent/i);
  });
});
