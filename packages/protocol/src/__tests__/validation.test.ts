import { describe, it, expect } from 'vitest';
import {
  ProtocolValidationError,
  validateEnvelope,
  tryValidateEnvelope,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  createHello,
} from '../index';

function sampleCapabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    supportsMatchAnalysis: true,
    supportsIcebreaker: true,
    supportsChatAssist: true,
    supportsEncryption: true,
  };
}

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const MSG_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseEnvelope() {
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: MSG_ID,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'hello' as const,
    sender: AGENT_ID,
    payload: { displayName: 'tester', capabilities: sampleCapabilities() },
  };
}

describe('@kindora/protocol — validateEnvelope', () => {
  it('accepts a valid hello envelope', () => {
    const e = validateEnvelope(baseEnvelope());
    expect(e.type).toBe('hello');
  });

  it('rejects non-object input', () => {
    expect(() => validateEnvelope('hi')).toThrow(ProtocolValidationError);
    expect(() => validateEnvelope(42)).toThrow(ProtocolValidationError);
    expect(() => validateEnvelope(null)).toThrow(ProtocolValidationError);
    expect(() => validateEnvelope([])).toThrow(ProtocolValidationError);
  });

  it('rejects wrong protocol', () => {
    const bad = { ...baseEnvelope(), protocol: 'OTHER' };
    expect(() => validateEnvelope(bad)).toThrow(/protocol/);
  });

  it('rejects wrong version', () => {
    const bad = { ...baseEnvelope(), version: '0.2' };
    expect(() => validateEnvelope(bad)).toThrow(/version/);
  });

  it('rejects non-UUID v4 messageId', () => {
    expect(() => validateEnvelope({ ...baseEnvelope(), messageId: 'not-a-uuid' })).toThrow(/UUID/);
    expect(() =>
      validateEnvelope({
        ...baseEnvelope(),
        messageId: 'aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee',
      }),
    ).toThrow(/UUID/);
  });

  it('rejects non-ISO-8601 timestamp', () => {
    expect(() => validateEnvelope({ ...baseEnvelope(), timestamp: 'yesterday' })).toThrow(
      /ISO-8601/,
    );
  });

  it('rejects sender that is not a UUID', () => {
    expect(() => validateEnvelope({ ...baseEnvelope(), sender: 'not-a-uuid' })).toThrow(/sender/);
  });

  it('rejects unknown message type', () => {
    const bad = { ...baseEnvelope(), type: 'banana' };
    expect(() => validateEnvelope(bad)).toThrow(/type/);
  });

  it('rejects payload that does not match the type schema', () => {
    // Missing the required `displayName` field for `hello`.
    expect(() => validateEnvelope({ ...baseEnvelope(), payload: { bogus: true } })).toThrow(
      /displayName/,
    );
  });

  it('rejects an envelope missing the payload field', () => {
    const { payload: _omit, ...rest } = baseEnvelope();
    expect(() => validateEnvelope(rest)).toThrow(/payload/);
  });

  it('rejects oversized fields with too-long code', () => {
    const longBio = 'x'.repeat(500);
    const profile = {
      nickname: 'tester',
      bio: longBio,
      interests: ['typescript' as const],
      currentActivities: [] as string[],
      socialIntent: ['similar_interests' as const],
      conversationStyle: ['casual' as const],
      boundaries: {
        allowAgentConversation: true,
        allowContactExchange: false,
        allowOfflineMeeting: false,
        allowProjectDetails: false,
        allowCurrentActivity: true,
      },
    };
    const e = {
      ...baseEnvelope(),
      type: 'profile_exchange' as const,
      payload: {
        profile,
        agent: {
          agentId: AGENT_ID,
          protocolVersion: PROTOCOL_VERSION,
          displayName: 'tester',
          publicKey: 'KEY',
          profile,
          capabilities: sampleCapabilities(),
        },
      },
    };
    expect(() => validateEnvelope(e)).toThrow(/exceeds 400/);
  });

  it('round-trips through tryValidateEnvelope on success and failure', () => {
    const ok = tryValidateEnvelope(baseEnvelope());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.envelope.type).toBe('hello');

    const bad = tryValidateEnvelope({ ...baseEnvelope(), protocol: 'OTHER' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBeInstanceOf(ProtocolValidationError);
  });

  it('uses ProtocolValidationError.code to allow programmatic handling', () => {
    try {
      validateEnvelope({ ...baseEnvelope(), version: '0.2' });
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolValidationError);
      const e = err as ProtocolValidationError;
      expect(e.field).toBe('version');
      expect(e.code).toBe('wrong-version');
    }
  });
});

import type { SocialAgent, SocialProfile } from '../index';

describe('@kindora/protocol — validateEnvelope (per-type payloads)', () => {
  const goodProfile: SocialProfile = {
    nickname: 'p',
    bio: 'b',
    interests: ['typescript'],
    currentActivities: [],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
  };
  const goodAgent: SocialAgent = {
    agentId: AGENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'p',
    publicKey: 'KEY',
    profile: goodProfile,
    capabilities: sampleCapabilities(),
  };

  it('accepts a valid profile_exchange', () => {
    const e = validateEnvelope({
      ...baseEnvelope(),
      type: 'profile_exchange',
      payload: { profile: goodProfile, agent: goodAgent },
    });
    expect(e.type).toBe('profile_exchange');
  });

  it('accepts a valid match_request', () => {
    const e = validateEnvelope({
      ...baseEnvelope(),
      type: 'match_request',
      payload: { selfProfile: goodProfile },
    });
    expect(e.type).toBe('match_request');
  });

  it('accepts a valid match_response', () => {
    const e = validateEnvelope({
      ...baseEnvelope(),
      type: 'match_response',
      payload: {
        analysis: {
          compatibilitySignal: 'moderate',
          commonGround: ['x'],
          recommendedTopics: ['y'],
          potentialFriction: [],
          explanation: 'ok',
        },
      },
    });
    expect(e.type).toBe('match_response');
  });

  it('rejects match_response with invalid signal', () => {
    expect(() =>
      validateEnvelope({
        ...baseEnvelope(),
        type: 'match_response',
        payload: {
          analysis: {
            compatibilitySignal: 'amazing',
            commonGround: [],
            recommendedTopics: [],
            potentialFriction: [],
            explanation: '',
          },
        },
      }),
    ).toThrow(/compatibilitySignal/);
  });

  it('accepts chat_message, icebreaker_request, icebreaker_response, permission_request, disconnect', () => {
    expect(
      validateEnvelope({ ...baseEnvelope(), type: 'chat_message', payload: { text: 'hi' } }).type,
    ).toBe('chat_message');
    expect(
      validateEnvelope({
        ...baseEnvelope(),
        type: 'icebreaker_request',
        payload: { topicHints: ['ts'] },
      }).type,
    ).toBe('icebreaker_request');
    expect(
      validateEnvelope({
        ...baseEnvelope(),
        type: 'icebreaker_response',
        payload: { topics: ['a', 'b'] },
      }).type,
    ).toBe('icebreaker_response');
    expect(
      validateEnvelope({
        ...baseEnvelope(),
        type: 'permission_request',
        payload: { permission: 'contact_exchange' },
      }).type,
    ).toBe('permission_request');
    expect(validateEnvelope({ ...baseEnvelope(), type: 'disconnect', payload: {} }).type).toBe(
      'disconnect',
    );
  });
});

describe('@kindora/protocol — built envelopes validate', () => {
  it('createHello output passes validateEnvelope', () => {
    const e = createHello(AGENT_ID, { displayName: 'p', capabilities: sampleCapabilities() });
    expect(() => validateEnvelope(e)).not.toThrow();
  });
});
