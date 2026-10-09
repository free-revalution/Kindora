import { describe, it, expect } from 'vitest';
import {
  createHello,
  createDisconnect,
  encodeEnvelope,
  decodeEnvelope,
  parseEnvelope,
  jsonStringifyEnvelope,
} from '../index';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

describe('@kindora/protocol — serialization', () => {
  it('round-trips a hello envelope', () => {
    const e = createHello(AGENT_ID, {
      displayName: 'tester',
      capabilities: {
        protocolVersion: '0.1',
        supportsMatchAnalysis: true,
        supportsIcebreaker: true,
        supportsChatAssist: true,
        supportsEncryption: true,
      },
    });
    const json = encodeEnvelope(e);
    const back = decodeEnvelope(json);
    expect(back).toEqual(e);
  });

  it('round-trips a disconnect envelope', () => {
    const e = createDisconnect(AGENT_ID, { reason: 'bye' });
    const back = decodeEnvelope(encodeEnvelope(e));
    expect(back).toEqual(e);
  });

  it('produces a canonical (sorted-key) JSON string', () => {
    const e = createDisconnect(AGENT_ID);
    const json = jsonStringifyEnvelope(e);
    // Keys appear in alphabetical order.
    const firstKey = json.indexOf('"');
    const lastKey = json.lastIndexOf('"');
    expect(firstKey).toBeLessThan(json.indexOf('messageId'));
    expect(json.indexOf('messageId')).toBeLessThan(json.indexOf('payload'));
    expect(json.indexOf('payload')).toBeLessThan(json.indexOf('protocol'));
    expect(json.indexOf('protocol')).toBeLessThan(json.indexOf('sender'));
    expect(json.indexOf('sender')).toBeLessThan(json.indexOf('timestamp'));
    expect(json.indexOf('timestamp')).toBeLessThan(json.indexOf('type'));
    expect(json.indexOf('type')).toBeLessThan(json.indexOf('version'));
    void lastKey;
  });

  it('parseEnvelope throws on malformed JSON', () => {
    expect(() => parseEnvelope('not json')).toThrow(/Envelope JSON/);
  });

  it('parseEnvelope throws on well-formed JSON that fails schema validation', () => {
    expect(() => parseEnvelope(JSON.stringify({ protocol: 'OTHER' }))).toThrow();
  });
});
