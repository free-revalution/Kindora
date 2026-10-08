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

  it('lists every V0.1 message type from 开发手册.md § 21', () => {
    const expected: MessageType[] = [
      'hello',
      'profile_exchange',
      'match_request',
      'match_response',
      'icebreaker_request',
      'icebreaker_response',
      'chat_message',
      'permission_request',
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

  it('freezes default boundaries to default-true only for agent conversation (开发手册.md § 9)', () => {
    expect(DEFAULT_SOCIAL_BOUNDARIES).toEqual({
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    });
    expect(Object.isFrozen(DEFAULT_SOCIAL_BOUNDARIES)).toBe(true);
  });

  it('freezes default agent capabilities', () => {
    expect(DEFAULT_AGENT_CAPABILITIES.protocolVersion).toBe('0.1');
    expect(DEFAULT_AGENT_CAPABILITIES.supportsMatchAnalysis).toBe(true);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsIcebreaker).toBe(true);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsChatAssist).toBe(true);
    expect(DEFAULT_AGENT_CAPABILITIES.supportsEncryption).toBe(true);
    expect(Object.isFrozen(DEFAULT_AGENT_CAPABILITIES)).toBe(true);
  });
});
