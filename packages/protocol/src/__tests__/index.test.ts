import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  SOCIAL_INTENTS,
  CONVERSATION_STYLES,
  DEFAULT_SOCIAL_BOUNDARIES,
  DEFAULT_AGENT_CAPABILITIES,
  type MessageType,
  type SocialIntent,
  type ConversationStyle,
} from '../index';

describe('@kindora/protocol', () => {
  it('exposes the KSA 0.1 protocol identity', () => {
    expect(PROTOCOL_NAME).toBe('KSA');
    expect(PROTOCOL_VERSION).toBe('0.1');
  });

  it('lists every V0.1 message type from 开发手册.md § 21 + Phase 7', () => {
    const expected: MessageType[] = [
      'hello',
      'profile_exchange',
      'match_request',
      'match_response',
      'icebreaker_request',
      'icebreaker_response',
      'chat_message',
      'permission_request',
      'consent_accept',
      'consent_reject',
      'block',
      'disconnect',
    ];
    expect([...MESSAGE_TYPES].sort()).toEqual([...expected].sort());
  });

  it('declares the V0.1 social intents from 开发手册.md § 8', () => {
    const expected: SocialIntent[] = [
      'similar_interests',
      'project_partner',
      'gaming_partner',
      'learning_partner',
      'technical_discussion',
      'long_term_friendship',
      'activity_partner',
    ];
    expect([...SOCIAL_INTENTS].sort()).toEqual([...expected].sort());
  });

  it('declares the V0.1 conversation styles from 开发手册.md § 6.2', () => {
    const expected: ConversationStyle[] = ['casual', 'deep', 'technical', 'funny', 'quiet'];
    expect([...CONVERSATION_STYLES].sort()).toEqual([...expected].sort());
  });

  it('freezes the default boundaries to the minimal-necessary set (Phase B / B1)', () => {
    // Phase B / B1 changed the defaults. They used to be the KSA 0.1
    // five: `allowAgentConversation` on and everything else off. The
    // five new field-level gates did not exist then, and
    // `allowCurrentActivity` was on — which contradicted "最小必要授权".
    //
    // The rule now (the user's ruling): the **behavioural** permissions
    // keep the KSA 0.1 shape — only `allowAgentConversation` is on.
    // The **field-level** gates are "interests on, the rest off", except
    // for `allowSocialIntent` / `allowConversationStyle`, which stay on
    // so the consent screen has something to show.
    //
    // This assertion is now *stronger* than the one it replaces: it pins
    // all ten keys, not five.
    expect(DEFAULT_SOCIAL_BOUNDARIES).toEqual({
      // behavioural
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      // field-level
      allowCurrentActivity: false,
      allowBio: false,
      allowInterests: true,
      allowAvatar: false,
      allowSocialIntent: true,
      allowConversationStyle: true,
    });
    expect(Object.isFrozen(DEFAULT_SOCIAL_BOUNDARIES)).toBe(true);
  });

  it('freezes default agent capabilities', () => {
    expect(DEFAULT_AGENT_CAPABILITIES.protocolVersion).toBe('0.1');
    expect(DEFAULT_AGENT_CAPABILITIES.supportsMatchAnalysis).toBe(true);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsIcebreaker).toBe(true);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsChatAssist).toBe(true);
    // Phase A / A4 — the old, ambiguous `supportsEncryption: true` is gone.
    // An agent that has not computed its capabilities from a real runtime
    // has no security capability at all.
    expect(DEFAULT_AGENT_CAPABILITIES.supportsMessageSigning).toBe(false);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsSessionEncryption).toBe(false);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsTransportEncryption).toBe(false);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsWebRtc).toBe(false);
    expect(Object.isFrozen(DEFAULT_AGENT_CAPABILITIES)).toBe(true);
  });
});
