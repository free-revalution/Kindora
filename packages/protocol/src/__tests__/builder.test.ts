import { describe, it, expect } from 'vitest';
import {
  createHello,
  createProfileExchange,
  createMatchRequest,
  createMatchResponse,
  createIcebreakerRequest,
  createIcebreakerResponse,
  createChatMessage,
  createPermissionRequest,
  createDisconnect,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from '../index';
import type { KsaMessage, SocialAgent, SocialProfile } from '../index';

const SENDER = '11111111-2222-4333-8444-555555555555';

function sampleSocialProfile(): SocialProfile {
  return {
    nickname: 'tester',
    bio: 'A tester.',
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
}

function sampleSocialAgent(): SocialAgent {
  return {
    agentId: SENDER,
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'Tester',
    publicKey: 'BASE64-PUBLIC-KEY',
    profile: sampleSocialProfile(),
    capabilities: {
      protocolVersion: PROTOCOL_VERSION,
      supportsMatchAnalysis: true,
      supportsIcebreaker: true,
      supportsChatAssist: true,
      supportsEncryption: true,
    },
  };
}

describe('@kindora/protocol — envelope builders', () => {
  it('createHello produces a frozen envelope with the right discriminator', () => {
    const e = createHello(SENDER, {
      displayName: 'Tester',
      capabilities: sampleSocialAgent().capabilities,
    });
    expect(e.protocol).toBe(PROTOCOL_NAME);
    expect(e.version).toBe(PROTOCOL_VERSION);
    expect(e.type).toBe('hello');
    expect(e.sender).toBe(SENDER);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e.payload)).toBe(true);
  });

  it('createProfileExchange embeds the profile + agent', () => {
    const agent = sampleSocialAgent();
    const e = createProfileExchange(SENDER, {
      profile: agent.profile,
      agent,
    });
    expect(e.type).toBe('profile_exchange');
    if (e.type !== 'profile_exchange') throw new Error('narrow');
    expect(e.payload.profile.nickname).toBe('tester');
    expect(e.payload.agent.agentId).toBe(SENDER);
  });

  it('createMatchRequest embeds the self profile', () => {
    const agent = sampleSocialAgent();
    const e = createMatchRequest(SENDER, { selfProfile: agent.profile });
    if (e.type !== 'match_request') throw new Error('narrow');
    expect(e.payload.selfProfile.nickname).toBe('tester');
  });

  it('createMatchResponse embeds the analysis', () => {
    const e = createMatchResponse(SENDER, {
      analysis: {
        compatibilitySignal: 'moderate',
        commonGround: ['typescript'],
        recommendedTopics: ['oss'],
        potentialFriction: [],
        explanation: 'ok',
      },
    });
    if (e.type !== 'match_response') throw new Error('narrow');
    expect(e.payload.analysis.compatibilitySignal).toBe('moderate');
  });

  it('createIcebreakerRequest + createIcebreakerResponse', () => {
    const req = createIcebreakerRequest(SENDER, { topicHints: ['typescript'] });
    expect(req.type).toBe('icebreaker_request');
    const res = createIcebreakerResponse(SENDER, { topics: ['a', 'b'] });
    if (res.type !== 'icebreaker_response') throw new Error('narrow');
    expect(res.payload.topics).toEqual(['a', 'b']);
  });

  it('createChatMessage stores text', () => {
    const e = createChatMessage(SENDER, { text: 'hi' });
    if (e.type !== 'chat_message') throw new Error('narrow');
    expect(e.payload.text).toBe('hi');
  });

  it('createPermissionRequest validates the kind at the type level', () => {
    const e = createPermissionRequest(SENDER, {
      permission: 'contact_exchange',
      reason: 'we get along',
    });
    if (e.type !== 'permission_request') throw new Error('narrow');
    expect(e.payload.permission).toBe('contact_exchange');
    expect(e.payload.reason).toBe('we get along');
  });

  it('createDisconnect accepts an empty payload', () => {
    const e = createDisconnect(SENDER);
    if (e.type !== 'disconnect') throw new Error('narrow');
    expect(e.payload).toEqual({});
  });

  it('all builders produce a valid UUID v4 and ISO-8601 timestamp', () => {
    const all: KsaMessage[] = [
      createHello(SENDER, { displayName: 't', capabilities: sampleSocialAgent().capabilities }),
      createDisconnect(SENDER),
      createChatMessage(SENDER, { text: 'hi' }),
    ];
    for (const e of all) {
      expect(e.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(e.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    }
  });

  it('honours caller-supplied messageId + timestamp (tests / reproducibility)', () => {
    const fixedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const fixedTs = '2026-01-01T00:00:00.000Z';
    const e = createDisconnect(SENDER, {}, { messageId: fixedId, timestamp: fixedTs });
    expect(e.messageId).toBe(fixedId);
    expect(e.timestamp).toBe(fixedTs);
  });
});
