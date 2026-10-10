import { describe, it, expect } from 'vitest';
import type { ChatMessage, LLMProvider, LLMResponse } from '@kindora/llm';
import type {
  ChatAssistHistoryEntry,
  ChatAssistReply,
  ChatAssistSuggestion,
} from '../chat-assist-orchestrator';
import {
  ChatAssistOrchestrator,
  summariseChatAssist,
} from '../chat-assist-orchestrator';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import { DEFAULT_SOCIAL_BOUNDARIES } from '@kindora/protocol';

const SELF_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa';

function makeProfile(overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname: 'alex',
    bio: 'Backend dev who likes hiking and tea.',
    interests: ['typescript', 'hiking'],
    currentActivities: ['reading'],
    socialIntent: ['similar_interests'],
    conversationStyle: ['deep'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
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

const VALID_REPLY = JSON.stringify({
  summary: 'Here are some thoughts.',
  suggestions: [
    {
      kind: 'reply',
      text: 'Yeah, the hardest part has been balancing concurrency and simplicity.',
      rationale: 'You both talked about distributed systems.',
    },
  ],
});

describe('@kindora/matching — ChatAssistOrchestrator', () => {
  it('ask() forwards the freshest history into the LLM call', async () => {
    const provider = stubProvider(VALID_REPLY);
    let live: readonly ChatAssistHistoryEntry[] = [];
    const orchestrator = new ChatAssistOrchestrator({
      selfAgentId: SELF_ID,
      selfProfile: makeProfile(),
      peerDisplayName: 'Sam',
      peerProfile: makeProfile({ nickname: 'sam' }),
      llm: provider,
      config: { maxChatAssistTokens: 1200 },
      getHistory: () => live,
    });

    live = [
      {
        direction: 'received',
        sender: '22222222-2222-4222-8222-bbbbbbbbbbbb',
        text: 'first message',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ];
    const first = await orchestrator.ask('help me reply');
    expect(first.reply.suggestions.length).toBeGreaterThan(0);

    live = [
      ...live,
      {
        direction: 'sent',
        sender: SELF_ID,
        text: 'second message',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    ];
    await orchestrator.ask('help again');
    expect(provider.calls).toHaveLength(2);
    const second = provider.calls[1]?.[1]?.content ?? '';
    expect(second).toContain('first message');
    expect(second).toContain('second message');
  });

  it('ask() falls back to a minimal peer profile when none is supplied', async () => {
    const provider = stubProvider(VALID_REPLY);
    const orchestrator = new ChatAssistOrchestrator({
      selfAgentId: SELF_ID,
      selfProfile: makeProfile(),
      peerDisplayName: 'Sam',
      peerProfile: null,
      llm: provider,
      config: { maxChatAssistTokens: 1200 },
      getHistory: () => [],
    });
    const result = await orchestrator.ask('help me reply');
    expect(result.degraded).toBe(false);
    expect(provider.calls).toHaveLength(1);
    const sent = provider.calls[0]?.[1]?.content ?? '';
    expect(sent).toContain('Peer profile');
    expect(sent).toContain('Sam');
  });

  it('short-circuits with boundaryBlocked=true when both sides disallow agent conversation', async () => {
    const provider = stubProvider(VALID_REPLY);
    const noAgent = makeProfile({
      boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES, allowAgentConversation: false },
    });
    const orchestrator = new ChatAssistOrchestrator({
      selfAgentId: SELF_ID,
      selfProfile: noAgent,
      peerDisplayName: 'Sam',
      peerProfile: noAgent,
      llm: provider,
      config: { maxChatAssistTokens: 1200 },
      getHistory: () => [],
    });
    const result = await orchestrator.ask('help');
    expect(result.boundaryBlocked).toBe(true);
    expect(result.reply.suggestions).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('parses invalid LLM output into an empty reply with degraded=true', async () => {
    const provider = stubProvider('not json at all');
    const orchestrator = new ChatAssistOrchestrator({
      selfAgentId: SELF_ID,
      selfProfile: makeProfile(),
      peerDisplayName: 'Sam',
      peerProfile: makeProfile({ nickname: 'sam' }),
      llm: provider,
      config: { maxChatAssistTokens: 1200 },
      getHistory: () => [],
    });
    const result = await orchestrator.ask('help');
    expect(result.degraded).toBe(true);
    expect(result.reply.suggestions).toEqual([]);
    expect(result.degradationNote).toMatch(/json-parse-failed/);
  });

  it('forwards the analysis into the user message', async () => {
    const provider = stubProvider(VALID_REPLY);
    const analysis: MatchAnalysis = {
      compatibilitySignal: 'moderate',
      commonGround: ['typescript'],
      recommendedTopics: ['side projects in TS'],
      potentialFriction: [],
      explanation: 'shared ground',
    };
    const orchestrator = new ChatAssistOrchestrator({
      selfAgentId: SELF_ID,
      selfProfile: makeProfile(),
      peerDisplayName: 'Sam',
      peerProfile: makeProfile({ nickname: 'sam' }),
      analysis,
      llm: provider,
      config: { maxChatAssistTokens: 1200 },
      getHistory: () => [],
    });
    await orchestrator.ask('help');
    const sent = provider.calls[0]?.[1]?.content ?? '';
    expect(sent).toContain('Match report');
    expect(sent).toContain('shared ground');
  });
});

describe('@kindora/matching — summariseChatAssist', () => {
  it('maps kinds to human labels and assigns stable ids', () => {
    const reply: ChatAssistReply = Object.freeze({
      summary: 'sum',
      suggestions: Object.freeze<ChatAssistSuggestion[]>([
        { kind: 'reply', text: 'r', rationale: '' },
        { kind: 'topic', text: 't', rationale: '' },
        { kind: 'explanation', text: 'e', rationale: 'why' },
      ]),
    });
    const out = summariseChatAssist(reply);
    expect(out.summary).toBe('sum');
    expect(out.suggestions).toHaveLength(3);
    expect(out.suggestions[0]?.kindLabel).toBe('Reply');
    expect(out.suggestions[1]?.kindLabel).toBe('Topic');
    expect(out.suggestions[2]?.kindLabel).toBe('Explain');
    // ids include kind + index so they're stable across renders.
    expect(out.suggestions[0]?.id).toMatch(/assist-0-reply/);
    expect(out.suggestions[2]?.id).toMatch(/assist-2-explanation/);
  });
});