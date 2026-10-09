import { describe, it, expect } from 'vitest';
import type { ChatMessage, LLMProvider, LLMResponse } from '@kindora/llm';
import {
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
  type CompatibilitySignal,
  type MatchAnalysis,
  type SocialProfile,
} from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport, PairingSession } from '@kindora/transport';
import { buildCapabilities, createAgentIdentity, type AgentIdentity } from '@kindora/agent';
import { MatchOrchestrator, DEFAULT_PEER_ANALYSIS_TIMEOUT_MS, type MatchOrchestratorSelf } from '../orchestrator';

const ID_A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const ID_B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function buildProfile(nickname: string, overrides: Partial<SocialProfile> = {}): SocialProfile {
  return {
    nickname,
    bio: `${nickname} bio`,
    interests: ['typescript', 'reading'],
    currentActivities: ['side project'],
    socialIntent: ['similar_interests'],
    conversationStyle: ['casual'],
    boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    ...overrides,
  };
}

interface StubProvider {
  readonly provider: LLMProvider;
  readonly replies: MatchAnalysis[];
  readonly calls: ChatMessage[][];
}

function stubProvider(reply: MatchAnalysis): StubProvider {
  const replies: MatchAnalysis[] = [reply];
  const calls: ChatMessage[][] = [];
  const provider: LLMProvider = {
    async chat(messages) {
      calls.push([...messages]);
      const next = replies.shift();
      if (!next) throw new Error('stubProvider: no more replies queued');
      const resp: LLMResponse = {
        content: JSON.stringify(next),
        model: 'stub',
      };
      return resp;
    },
  };
  return { provider, replies, calls };
}

function cannedAnalysis(signal: CompatibilitySignal = 'moderate'): MatchAnalysis {
  return {
    compatibilitySignal: signal,
    commonGround: ['typescript'],
    recommendedTopics: ['side projects in TS'],
    potentialFriction: ['timezones'],
    explanation: 'some shared ground',
  };
}

interface Pair {
  sessionA: PairingSession;
  sessionB: PairingSession;
}

async function makePair(): Promise<Pair> {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
  const sessionB = new PairingSession({ agentId: ID_B, displayName: 'Bob' });
  const ta = new LoopbackTransport({ endpointId: ID_A, hub });
  const tb = new LoopbackTransport({ endpointId: ID_B, hub });
  const code = sessionA.startHost(ta);
  await sessionB.startJoin(tb, code);
  if (ta.isConnected()) sessionA.notifyPeerConnected();
  return { sessionA, sessionB };
}

interface Self {
  agentId: string;
  displayName: string;
  profile: SocialProfile;
  identity: AgentIdentity;
  llm: LLMProvider;
}

async function makeSelf(agentId: string, displayName: string, llm: LLMProvider): Promise<Self> {
  const identity = await createAgentIdentity();
  return { agentId, displayName, profile: buildProfile(displayName), identity, llm };
}

function selfToDeps(self: Self): MatchOrchestratorSelf {
  return {
    agentId: self.agentId,
    displayName: self.displayName,
    profile: self.profile,
    agent: {
      agentId: self.agentId,
      protocolVersion: PROTOCOL_VERSION,
      displayName: self.displayName,
      publicKey: self.identity.publicKey,
      profile: self.profile,
      capabilities: buildCapabilities(),
    },
    capabilities: buildCapabilities(),
    llm: self.llm,
  };
}

describe('@kindora/matching — MatchOrchestrator', () => {
  // We rely on real timers and microtasks; the orchestrator uses
  // setTimeout for the peer-analysis wait, but those timeouts are
  // short (50–100ms in the tests) and `vi.useFakeTimers` can starve
  // awaited microtasks under fast-loopback delivery.
  it('drives the full handshake and returns local + peer analysis (happy path)', async () => {
    const { sessionA, sessionB } = await makePair();
    const aStub = stubProvider(cannedAnalysis('strong'));
    const bStub = stubProvider(cannedAnalysis('moderate'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
    const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

    const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

    // Both sides start concurrently. The orchestrator registers its
    // queue handler before its first send, so any peer message that
    // arrives before the matching `queue.next` is buffered and
    // delivered when the waiter is registered.
    const [outA, outB] = await Promise.all([orchA.start(sessionA), orchB.start(sessionB)]);

    expect(outA.localAnalysis.compatibilitySignal).toBe('strong');
    expect(outA.peerAnalysis?.compatibilitySignal).toBe('moderate');
    expect(outB.localAnalysis.compatibilitySignal).toBe('moderate');
    expect(outB.peerAnalysis?.compatibilitySignal).toBe('strong');
    expect(outA.peerProfile?.nickname).toBe('Bob');
    expect(outB.peerProfile?.nickname).toBe('Alice');
    expect(aStub.calls).toHaveLength(1);
    expect(bStub.calls).toHaveLength(1);
  });

  it('boundary block: both sides disable agent conversation → local signal "none", no LLM call', async () => {
    const { sessionA, sessionB } = await makePair();
    const llmA: LLMProvider = { async chat() { throw new Error('LLM should not be called'); } };
    const llmB: LLMProvider = { async chat() { throw new Error('LLM should not be called'); } };
    const selfA = await makeSelf(ID_A, 'Alice', llmA);
    const selfB = await makeSelf(ID_B, 'Bob', llmB);
    const blockedBoundaries = {
      allowAgentConversation: false,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    };
    selfA.profile.boundaries = blockedBoundaries;
    selfB.profile.boundaries = blockedBoundaries;

    const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

    const [outA, outB] = await Promise.all([orchA.start(sessionA), orchB.start(sessionB)]);
    expect(outA.localAnalysis.compatibilitySignal).toBe('none');
    expect(outB.localAnalysis.compatibilitySignal).toBe('none');
    // Peer analysis is still delivered (each side runs its own — § 23).
    expect(outA.peerAnalysis?.compatibilitySignal).toBe('none');
    expect(outB.peerAnalysis?.compatibilitySignal).toBe('none');
  });

  it('LLM produces malformed JSON → orchestrator still returns a defaulted analysis (degraded)', async () => {
    const { sessionA } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        return { content: 'this is not json', model: 'stub' };
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llmA);

    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 50,
      earlyWaitTimeoutMs: 50,
    });

    const out = await orch.start(sessionA);
    expect(out.localAnalysis).toBeDefined();
    expect(['none', 'weak', 'moderate', 'strong']).toContain(out.localAnalysis.compatibilitySignal);
    expect(out.localResult.degraded).toBe(true);
    // Peer never responded → timed out, peerAnalysis is null.
    expect(out.peerAnalysis).toBeNull();
    expect(out.peerAnalysisTimedOut).toBe(true);
  });

  it('times out waiting for the peer match_response → peerAnalysis is null, local unaffected', async () => {
    const { sessionA } = await makePair();
    const aStub = stubProvider(cannedAnalysis('strong'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);

    // Peer B never calls start() — so it never sends match_response.

    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 50,
      earlyWaitTimeoutMs: 50,
    });

    const out = await orch.start(sessionA);
    expect(out.localAnalysis.compatibilitySignal).toBe('strong');
    expect(out.peerAnalysis).toBeNull();
    expect(out.peerAnalysisTimedOut).toBe(true);
    expect(out.peerAnalysisTimeoutMs).toBe(50);
    expect(aStub.calls).toHaveLength(1);
  });

  it('falls back to agentId slice when peer sends no profile_exchange', async () => {
    const { sessionA } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        return { content: JSON.stringify(cannedAnalysis('weak')), model: 'stub' };
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llmA);

    // We only have the orchestrator on side A; side B never sends its
    // profile_exchange. The orchestrator's queue.next() will time out,
    // so peerProfile / peerAgent will be null, and the display name
    // falls back to the agentId prefix.
    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 100,
      earlyWaitTimeoutMs: 50,
    });
    const out = await orch.start(sessionA);
    expect(out.peerDisplayName).toBe(ID_B.slice(0, 8));
    expect(out.peerProfile).toBeNull();
    expect(out.peerAgent).toBeNull();
  });

  it('rejects start() when the session is not connected', async () => {
    const llm: LLMProvider = { async chat() { throw new Error('not called'); } };
    const selfA = await makeSelf(ID_A, 'Alice', llm);
    const session = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    await expect(orch.start(session)).rejects.toThrow(/connected/i);
  });

  it('exposes the default peer-analysis timeout constant', () => {
    expect(DEFAULT_PEER_ANALYSIS_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
