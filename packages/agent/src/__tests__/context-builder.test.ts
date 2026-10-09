import { describe, it, expect } from 'vitest';
import type { SocialProfile } from '@kindora/protocol';
import {
  buildMatchContext,
  renderMatchUserMessage,
  estimateTokens,
  TokenLimitExceeded,
} from '../context-builder';

const SELF: SocialProfile = {
  nickname: 'alex',
  bio: 'Backend dev who likes hiking and tea.',
  interests: ['typescript', 'hiking', 'tea'],
  currentActivities: ['reading'],
  socialIntent: ['similar_interests'],
  conversationStyle: ['deep'],
  boundaries: {
    allowAgentConversation: true,
    allowContactExchange: false,
    allowOfflineMeeting: false,
    allowProjectDetails: false,
    allowCurrentActivity: true,
  },
};

const PEER: SocialProfile = {
  nickname: 'sam',
  bio: 'Frontend dev, also into hiking and tea.',
  interests: ['hiking', 'tea', 'design'],
  currentActivities: ['reading'],
  socialIntent: ['similar_interests'],
  conversationStyle: ['deep', 'casual'],
  boundaries: {
    allowAgentConversation: true,
    allowContactExchange: false,
    allowOfflineMeeting: false,
    allowProjectDetails: false,
    allowCurrentActivity: true,
  },
};

describe('@kindora/agent — estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('uses chars-per-token to round up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('honours a custom charsPerToken', () => {
    expect(estimateTokens('hello', 2)).toBe(3);
  });

  it('throws on non-positive charsPerToken', () => {
    expect(() => estimateTokens('x', 0)).toThrow();
  });
});

describe('@kindora/agent — renderMatchUserMessage', () => {
  it('includes both profiles and the untrusted-input warning', () => {
    const out = renderMatchUserMessage({
      selfProfile: SELF,
      peerProfile: PEER,
      selfDisplayName: 'Alex',
      peerDisplayName: 'Sam',
    });
    expect(out).toContain('Self profile');
    expect(out).toContain('Peer profile');
    expect(out).toContain('Alex');
    expect(out).toContain('Sam');
    expect(out).toMatch(/untrusted/i);
    expect(out).toContain('Structured matching hints');
  });
});

describe('@kindora/agent — buildMatchContext', () => {
  it('returns exactly one system and one user message', () => {
    const messages = buildMatchContext({ selfProfile: SELF, peerProfile: PEER });
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
  });

  it('user message contains both profile blocks', () => {
    const messages = buildMatchContext({ selfProfile: SELF, peerProfile: PEER });
    const user = messages[1];
    expect(user?.content).toContain('alex');
    expect(user?.content).toContain('sam');
  });

  it('throws TokenLimitExceeded when the budget is too small', () => {
    expect(() =>
      buildMatchContext({ selfProfile: SELF, peerProfile: PEER }, { maxTokens: 50 }),
    ).toThrow(TokenLimitExceeded);
  });

  it('never includes secrets in the system prompt (peer bio may contain them as data)', () => {
    const messages = buildMatchContext({
      selfProfile: { ...SELF, bio: 'sk-secret-12345 here' },
      peerProfile: PEER,
    });
    expect(messages[0]?.content).not.toMatch(/sk-/);
  });

  it('respects a generous custom budget', () => {
    const messages = buildMatchContext(
      { selfProfile: SELF, peerProfile: PEER },
      { maxTokens: 10_000 },
    );
    expect(messages).toHaveLength(2);
  });
});
