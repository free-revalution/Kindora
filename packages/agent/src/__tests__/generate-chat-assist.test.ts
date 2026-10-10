import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage, LLMProvider, LLMResponse } from '@kindora/llm';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import { generateChatAssist } from '../generate-chat-assist';
import type { ChatHistoryEntryLike } from '../context-builder';

function makeProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'alex',
    bio: 'Backend dev who likes hiking and tea.',
    interests: ['typescript', 'hiking'],
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
    ...overrides,
  };
}

function stubProvider(reply: string): LLMProvider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const provider: LLMProvider & { calls: ChatMessage[][] } = {
    calls,
    async chat(messages: readonly ChatMessage[]): Promise<LLMResponse> {
      calls.push([...messages]);
      return Object.freeze({ content: reply, model: 'fake-model' });
    },
  };
  return provider;
}

const SELF_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const PEER_ID = '22222222-2222-4222-8222-bbbbbbbbbbbb';

function entry(s: { direction: 'sent' | 'received'; sender?: string; text: string }): ChatHistoryEntryLike {
  return {
    direction: s.direction,
    sender: s.sender ?? (s.direction === 'sent' ? SELF_ID : PEER_ID),
    text: s.text,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

const VALID_REPLY_JSON = JSON.stringify({
  summary: 'Here are some thoughts.',
  suggestions: [
    {
      kind: 'reply',
      text: 'Yeah, the hardest part has been balancing concurrency and simplicity.',
      rationale: 'You both talked about distributed systems.',
    },
    {
      kind: 'topic',
      text: 'What part of your current Agent project excites you most?',
      rationale: 'Both sides mentioned Agent work.',
    },
  ],
});

const SAMPLE_ANALYSIS: MatchAnalysis = {
  compatibilitySignal: 'moderate',
  commonGround: ['typescript'],
  recommendedTopics: ['side projects in TS'],
  potentialFriction: [],
  explanation: 'Some shared ground.',
};

describe('@kindora/agent — generateChatAssist', () => {
  it('returns suggestions on a successful round-trip', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    const result = await generateChatAssist(provider, {
      selfProfile: makeProfile(),
      selfAgentId: SELF_ID,
      peerProfile: makeProfile({ nickname: 'sam' }),
      peerDisplayName: 'Sam',
      history: [entry({ direction: 'received', text: 'Hey!' })],
      userQuery: 'help me reply',
    });
    expect(result.degraded).toBe(false);
    expect(result.reply.suggestions.length).toBeGreaterThan(0);
    expect(result.reply.summary).toContain('thoughts');
    expect(result.boundaryBlocked).toBe(false);
  });

  it('sends exactly one system + one user message', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    await generateChatAssist(provider, {
      selfProfile: makeProfile(),
      selfAgentId: SELF_ID,
      peerProfile: makeProfile({ nickname: 'sam' }),
      history: [],
      userQuery: 'help',
    });
    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0] ?? [];
    expect(sent).toHaveLength(2);
    expect(sent[0]?.role).toBe('system');
    expect(sent[1]?.role).toBe('user');
  });

  it('forwards chat history + analysis + the user query into the user message', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    await generateChatAssist(provider, {
      selfProfile: makeProfile(),
      selfAgentId: SELF_ID,
      peerProfile: makeProfile({ nickname: 'sam' }),
      analysis: SAMPLE_ANALYSIS,
      history: [
        entry({ direction: 'received', text: 'Long history entry that the agent should see.' }),
      ],
      userQuery: 'reply to their point about TS',
    });
    const sent = provider.calls[0]?.[1]?.content ?? '';
    expect(sent).toContain('Long history entry');
    expect(sent).toContain('reply to their point about TS');
    expect(sent).toContain('Match report');
    expect(sent).toMatch(/untrusted/i);
  });

  it('marks peer entries in history as UNTRUSTED, leaves local entries unmarked', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    await generateChatAssist(provider, {
      selfProfile: makeProfile(),
      selfAgentId: SELF_ID,
      peerProfile: makeProfile({ nickname: 'sam' }),
      history: [
        entry({ direction: 'sent', text: 'local message' }),
        entry({ direction: 'received', text: 'peer message' }),
      ],
      userQuery: 'help',
    });
    const sent = provider.calls[0]?.[1]?.content ?? '';
    expect(sent).toMatch(/\[Local\].*local message/s);
    expect(sent).toMatch(/\[Peer \(UNTRUSTED\)\].*peer message/s);
  });

  it('short-circuits with boundaryBlocked=true when both sides disallow agent conversation', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    const noAgent = makeProfile({
      boundaries: { ...makeProfile().boundaries, allowAgentConversation: false },
    });
    const result = await generateChatAssist(provider, {
      selfProfile: noAgent,
      selfAgentId: SELF_ID,
      peerProfile: noAgent,
      history: [],
      userQuery: 'help',
    });
    expect(result.boundaryBlocked).toBe(true);
    expect(result.reply.suggestions).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.degradationNote).toMatch(/boundary/);
    expect(provider.calls).toHaveLength(0);
  });

  it('falls back to empty reply with degraded=true on unparseable LLM output', async () => {
    const provider = stubProvider('not json at all');
    const result = await generateChatAssist(provider, {
      selfProfile: makeProfile(),
      selfAgentId: SELF_ID,
      peerProfile: makeProfile({ nickname: 'sam' }),
      history: [],
      userQuery: 'help',
    });
    expect(result.degraded).toBe(true);
    expect(result.reply.suggestions).toEqual([]);
    expect(result.degradationNote).toMatch(/json-parse-failed/);
  });

  it('forwards an abort signal to the LLM provider', async () => {
    const controller = new AbortController();
    const spy = vi.fn(
      async (
        _msgs: readonly ChatMessage[],
        _options?: { signal?: AbortSignal },
      ): Promise<LLMResponse> => {
        return Object.freeze({ content: VALID_REPLY_JSON, model: 'fake-model' });
      },
    );
    const provider: LLMProvider = { chat: spy as unknown as LLMProvider['chat'] };
    await generateChatAssist(
      provider,
      {
        selfProfile: makeProfile(),
        selfAgentId: SELF_ID,
        peerProfile: makeProfile({ nickname: 'sam' }),
        history: [],
        userQuery: 'help',
      },
      { maxChatAssistTokens: 1200 },
      { llm: { signal: controller.signal } },
    );
    const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
    const optionsArg = lastCall?.[1] as { signal?: AbortSignal } | undefined;
    expect(optionsArg?.signal).toBe(controller.signal);
  });

  it('respects a custom token budget (throws on overflow, no LLM call)', async () => {
    const provider = stubProvider(VALID_REPLY_JSON);
    await expect(
      generateChatAssist(
        provider,
        {
          selfProfile: makeProfile(),
          selfAgentId: SELF_ID,
          peerProfile: makeProfile({ nickname: 'sam' }),
          history: [],
          userQuery: 'help',
        },
        { maxChatAssistTokens: 1200 },
        { tokenBudget: 50 },
      ),
    ).rejects.toThrow(/token budget/i);
    expect(provider.calls).toHaveLength(0);
  });
});