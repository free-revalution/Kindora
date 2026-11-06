import { describe, it, expect } from 'vitest';
import type { ChatMessage, LLMProvider, LLMResponse } from '@kindora/llm';
import {
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
  createConsentAccept,
  createConsentReject,
  type CompatibilitySignal,
  type KsaMessage,
  type MatchAnalysis,
  type SocialProfile,
} from '@kindora/protocol';
import {
  LoopbackHub,
  LoopbackTransport,
  PairingSession,
  type CloseReason,
} from '@kindora/transport';
import { buildCapabilities, createAgentIdentity, type AgentIdentity } from '@kindora/agent';
import {
  ConsentRequiredError,
  DEFAULT_PEER_ANALYSIS_TIMEOUT_MS,
  HandshakeClosedError,
  HandshakeTimeoutError,
  HandshakeValidationError,
  MatchOrchestrator,
  PeerBlockedError,
  type LocalConsent,
  type MatchOrchestratorSelf,
} from '../orchestrator';

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

async function makePair(opts: { handshake?: boolean } = {}): Promise<Pair> {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
  const sessionB = new PairingSession({ agentId: ID_B, displayName: 'Bob' });
  const ta = new LoopbackTransport({ endpointId: ID_A, hub });
  const tb = new LoopbackTransport({ endpointId: ID_B, hub });
  const code = sessionA.startHost(ta);
  await sessionB.startJoin(tb, code);
  if (ta.isConnected()) sessionA.notifyPeerConnected();
  // Phase 15: by default, simulate the orchestrator having validated
  // each side's `hello` envelope. Tests that need to drive the
  // handshake themselves pass `{ handshake: false }`.
  if (opts.handshake !== false) {
    if (sessionA.current().state === 'tcp-connected') {
      sessionA.notifyHelloReceived(ID_B);
    }
    if (sessionB.current().state === 'tcp-connected') {
      sessionB.notifyHelloReceived(ID_A);
    }
  }
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

function selfToDeps(
  self: Self,
  peerGuard?: (id: string) => void | Promise<void>,
  boundaries?: () => Partial<Self['profile']['boundaries']> | undefined,
): MatchOrchestratorSelf {
  const base: MatchOrchestratorSelf = {
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
  if (peerGuard) {
    return { ...base, peerGuard };
  }
  if (boundaries) {
    return { ...base, boundaries };
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Phase B helpers                                                     */
/* ------------------------------------------------------------------ */

/** Record every envelope this session puts on the wire. */
function recordOutbound(session: PairingSession): KsaMessage[] {
  const sent: KsaMessage[] = [];
  const original = session.send.bind(session);
  session.send = async (message: KsaMessage) => {
    sent.push(message);
    return original(message);
  };
  return sent;
}

/** Record every envelope this session receives. */
function recordInbound(session: PairingSession): KsaMessage[] {
  const received: KsaMessage[] = [];
  session.onMessage((msg) => {
    received.push(msg);
  });
  return received;
}

function outboundOfType(sent: readonly KsaMessage[], type: KsaMessage['type']): KsaMessage[] {
  return sent.filter((m) => m.type === type);
}

/**
 * A mutual consent for `peerAgentId` — the shape the `ConsentOrchestrator`
 * resolves with when both sides accepted.
 */
function mutualConsent(peerAgentId: string): LocalConsent {
  return { state: 'accepted_both', peerAgentId, bothAccepted: true };
}

/**
 * Phase B: both sides accept. The `consent_accept` envelopes go on the
 * wire exactly as the `ConsentOrchestrator` would send them — the
 * MatchOrchestrator waits for the peer's envelope before it discloses
 * anything.
 */
async function acceptOnBothSides(
  sessionA: PairingSession,
  sessionB: PairingSession,
): Promise<void> {
  await Promise.all([
    sessionA.send(createConsentAccept(ID_A)),
    sessionB.send(createConsentAccept(ID_B)),
  ]);
}

describe('@kindora/matching — MatchOrchestrator', () => {
  // We rely on real timers and microtasks; the orchestrator uses
  // setTimeout for the peer-analysis wait, but those timeouts are
  // short (50–100ms in the tests) and `vi.useFakeTimers` can starve
  // awaited microtasks under fast-loopback delivery.
  it('drives the full two-phase flow and returns local + peer analysis (happy path)', async () => {
    const { sessionA, sessionB } = await makePair();
    const aStub = stubProvider(cannedAnalysis('strong'));
    const bStub = stubProvider(cannedAnalysis('moderate'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
    const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

    const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

    // Phase 1 — identify. Both sides exchange their public cards.
    const [introA, introB] = await Promise.all([
      orchA.identify(sessionA),
      orchB.identify(sessionB),
    ]);
    expect(introA.peerAgentId).toBe(ID_B);
    expect(introA.peerDisplayName).toBe('Bob');
    expect(introA.peerCard?.nickname).toBe('Bob');
    expect(introB.peerAgentId).toBe(ID_A);

    // Phase B — the human consent step.
    await acceptOnBothSides(sessionA, sessionB);

    // Phase 2 — exchange the authorised profiles and analyse.
    const [outA, outB] = await Promise.all([
      orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
      orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
    ]);

    expect(outA.localAnalysis.compatibilitySignal).toBe('strong');
    expect(outA.peerAnalysis?.compatibilitySignal).toBe('moderate');
    expect(outB.localAnalysis.compatibilitySignal).toBe('moderate');
    expect(outB.peerAnalysis?.compatibilitySignal).toBe('strong');
    expect(outA.peerProfile?.nickname).toBe('Bob');
    expect(outB.peerProfile?.nickname).toBe('Alice');
    expect(aStub.calls).toHaveLength(1);
    expect(bStub.calls).toHaveLength(1);
  });

  it('the block-list guard refuses the peer BEFORE any profile is sent', async () => {
    // Phase B: the old flow ran the guard *after* the profile exchange,
    // so a blocked peer still received the full profile. The guard now
    // runs before the public card is sent.
    const { sessionA, sessionB } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        throw new Error('LLM should not be called');
      },
    };
    const llmB = stubProvider(cannedAnalysis('moderate'));
    const selfA = await makeSelf(ID_A, 'Alice', llmA);
    const selfB = await makeSelf(ID_B, 'Bob', llmB.provider);

    const receivedByB = recordInbound(sessionB);
    const sentByA = recordOutbound(sessionA);

    // A refuses B as soon as it learns the peer's id.
    const depsA = selfToDeps(selfA, (id) => {
      if (id === ID_B) throw new PeerBlockedError(id, 'on the local block list');
    });
    const orchA = new MatchOrchestrator(depsA, ID_B);
    const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A, undefined);

    // B keeps running: it may lose the link when A tears the session
    // down, which is exactly what we want (a blocked peer must not be
    // left holding a half-open session).
    const bIdentify = orchB.identify(sessionB).catch(() => undefined);
    await expect(orchA.identify(sessionA)).rejects.toBeInstanceOf(PeerBlockedError);
    await bIdentify;

    // Nothing that carries profile data reached the blocked peer.
    expect(receivedByB.filter((m) => m.type === 'profile_exchange')).toHaveLength(0);
    expect(receivedByB.filter((m) => m.type === 'match_request')).toHaveLength(0);
    // The only thing A sent was the hello — which carries no profile
    // fields at all.
    expect(sentByA.map((m) => m.type)).toEqual(['hello']);
    // And the session was torn down rather than left hanging.
    expect(sessionA.current().state).toBe('closed');
  });

  it('boundary block: both sides disable agent conversation → local signal "none", no LLM call', async () => {
    const { sessionA, sessionB } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        throw new Error('LLM should not be called');
      },
    };
    const llmB: LLMProvider = {
      async chat() {
        throw new Error('LLM should not be called');
      },
    };
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

    await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
    await acceptOnBothSides(sessionA, sessionB);
    const [outA, outB] = await Promise.all([
      orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
      orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
    ]);
    expect(outA.localAnalysis.compatibilitySignal).toBe('none');
    expect(outB.localAnalysis.compatibilitySignal).toBe('none');
    // Peer analysis is still delivered (each side runs its own — § 23).
    expect(outA.peerAnalysis?.compatibilitySignal).toBe('none');
    expect(outB.peerAnalysis?.compatibilitySignal).toBe('none');
  });

  it('LLM produces malformed JSON → orchestrator still returns a defaulted analysis (degraded)', async () => {
    const { sessionA, sessionB } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        return { content: 'this is not json', model: 'stub' };
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llmA);

    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 50,
      earlyWaitTimeoutMs: 50,
      peerConsentTimeoutMs: 200,
    });

    await orch.identify(sessionA);
    // The peer accepts; it just never runs a match of its own.
    await sessionB.send(createConsentAccept(ID_B));

    const out = await orch.exchangeAndMatch(sessionA, mutualConsent(ID_B));
    expect(out.localAnalysis).toBeDefined();
    expect(['none', 'weak', 'moderate', 'strong']).toContain(out.localAnalysis.compatibilitySignal);
    expect(out.localResult.degraded).toBe(true);
    // Peer never responded → timed out, peerAnalysis is null.
    expect(out.peerAnalysis).toBeNull();
    expect(out.peerAnalysisTimedOut).toBe(true);
  });

  it('times out waiting for the peer match_response → peerAnalysis is null, local unaffected', async () => {
    const { sessionA, sessionB } = await makePair();
    const aStub = stubProvider(cannedAnalysis('strong'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);

    // Peer B never identifies — so it never sends a match_response.

    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 50,
      earlyWaitTimeoutMs: 50,
      peerConsentTimeoutMs: 200,
    });

    await orch.identify(sessionA);
    await sessionB.send(createConsentAccept(ID_B));

    const out = await orch.exchangeAndMatch(sessionA, mutualConsent(ID_B));
    expect(out.localAnalysis.compatibilitySignal).toBe('strong');
    expect(out.peerAnalysis).toBeNull();
    expect(out.peerAnalysisTimedOut).toBe(true);
    expect(out.peerAnalysisTimeoutMs).toBe(50);
    expect(aStub.calls).toHaveLength(1);
  });

  it('falls back to agentId slice when peer sends no profile_exchange', async () => {
    const { sessionA, sessionB } = await makePair();
    const llmA: LLMProvider = {
      async chat() {
        return { content: JSON.stringify(cannedAnalysis('weak')), model: 'stub' };
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llmA);

    // We only have the orchestrator on side A; side B never sends its
    // profile_exchange. The orchestrator's queue.next() will time out,
    // so peerCard / peerAgent will be null, and the display name
    // falls back to the agentId prefix.
    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 100,
      earlyWaitTimeoutMs: 50,
      peerConsentTimeoutMs: 200,
    });
    const intro = await orch.identify(sessionA);
    expect(intro.peerDisplayName).toBe(ID_B.slice(0, 8));
    expect(intro.peerCard).toBeNull();
    expect(intro.peerAgent).toBeNull();

    await sessionB.send(createConsentAccept(ID_B));
    const out = await orch.exchangeAndMatch(sessionA, mutualConsent(ID_B));
    // No peer profile at all → the fallback minimal profile is used.
    expect(out.peerProfile?.nickname).toBe(ID_B.slice(0, 8));
  });

  it('learns the peer id from the session when the peer hello envelope never arrives (Phase A / R-2 regression guard)', async () => {
    // Regression guard for the Phase A / R-2 defect.
    //
    // The orchestrator used to drain the already-buffered messages
    // *non-blockingly* when the session already reported `connected`.
    // Our own `hello` is sent asynchronously (Phase A / A3 derives an
    // ephemeral key before the envelope goes out), so the peer's hello
    // could arrive *after* that drain — and a message that arrives
    // after the drain is never seen again. The peer id then stayed
    // EMPTY, and every downstream consumer that filters by sender (the
    // chat orchestrator and the consent orchestrator) dropped the
    // peer's messages silently, which looks exactly like a lost
    // connection.
    //
    // Here the peer never sends a hello at all, so the id has to come
    // from the session — `notifyHelloReceived(peerAgentId)` locked it
    // in, and 'connected' is only reachable through it.
    const { sessionA } = await makePair();
    const aStub = stubProvider(cannedAnalysis('moderate'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);

    // NOTE the empty peer id: the orchestrator has to learn it.
    const orch = new MatchOrchestrator(selfToDeps(selfA), '', {
      peerHelloGraceMs: 20,
      peerAnalysisTimeoutMs: 50,
      earlyWaitTimeoutMs: 50,
    });

    const intro = await orch.identify(sessionA);
    expect(intro.peerAgentId).toBe(ID_B);
    // With no hello envelope there is no display name either — it
    // falls back to the id prefix, which is only non-empty because the
    // id was learned. Before the fix this was ''.
    expect(intro.peerDisplayName).toBe(ID_B.slice(0, 8));
  });

  it('rejects identify() when the session is not connected', async () => {
    const llm: LLMProvider = {
      async chat() {
        throw new Error('not called');
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llm);
    const session = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    await expect(orch.identify(session)).rejects.toThrow(/connected/i);
  });

  it('rejects a second identify() on the same orchestrator instance (reentrancy guard)', async () => {
    // Defence-in-depth: a single MatchOrchestrator must never be
    // driven twice. The connect-service / ConnectView paths should
    // cache one instance per pairing, but if a bug ever calls identify()
    // twice the orchestrator throws instead of silently shipping a
    // second `profile_exchange`.
    const { sessionA, sessionB } = await makePair({ handshake: false });
    const aStub = stubProvider(cannedAnalysis('strong'));
    const bStub = stubProvider(cannedAnalysis('moderate'));
    const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
    const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
    const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
      peerAnalysisTimeoutMs: 200,
      earlyWaitTimeoutMs: 100,
      helloTimeoutMs: 1000,
    });
    const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A, {
      peerAnalysisTimeoutMs: 200,
      earlyWaitTimeoutMs: 100,
      helloTimeoutMs: 1000,
    });
    await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
    // First identify() succeeded; the second must throw.
    await expect(orchA.identify(sessionA)).rejects.toThrow(/already been called/i);
  });

  it('rejects exchangeAndMatch() before identify() has run', async () => {
    // Phase B: phase 2 cannot be reached without phase 1 — the public
    // card must be exchanged before the consent step.
    const llm: LLMProvider = {
      async chat() {
        throw new Error('not called');
      },
    };
    const selfA = await makeSelf(ID_A, 'Alice', llm);
    const { sessionA } = await makePair();
    const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B);
    await expect(orch.exchangeAndMatch(sessionA, mutualConsent(ID_B))).rejects.toThrow(
      /identify\(\)/i,
    );
  });

  it('exposes the default peer-analysis timeout constant', () => {
    expect(DEFAULT_PEER_ANALYSIS_TIMEOUT_MS).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- */
  /* Phase B — the privacy guarantees                                   */
  /* ---------------------------------------------------------------- */
  describe('Phase B — profile disclosure is gated by the user consent', () => {
    it('the profile_exchange carries only the public card', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
      // Everything is switched off except the social intent / style —
      // the minimum the consent screen needs.
      selfA.profile.boundaries = {
        ...DEFAULT_SOCIAL_BOUNDARIES,
        allowBio: false,
        allowInterests: false,
        allowCurrentActivity: false,
        allowAvatar: false,
      };
      selfA.profile.avatar = 'data:image/png;base64,AAAA';

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      const exchanges = outboundOfType(sentByA, 'profile_exchange');
      expect(exchanges).toHaveLength(1);
      const payload = exchanges[0]!.payload as {
        profile: SocialProfile;
        agent: { profile: SocialProfile };
      };
      expect(payload.profile.nickname).toBe('Alice');
      expect(payload.profile.bio).toBe('');
      expect(payload.profile.interests).toEqual([]);
      expect(payload.profile.currentActivities).toEqual([]);
      expect(payload.profile.avatar).toBeUndefined();
      // The social intent / conversation style survive — they are what
      // the consent screen shows.
      expect(payload.profile.socialIntent).toEqual(['similar_interests']);
      // The agent view carries the SAME card — the full profile is not
      // smuggled through the nested `agent.profile`.
      expect(payload.agent.profile).toEqual(payload.profile);
      expect(payload.agent.profile.bio).toBe('');
      expect(payload.agent.profile.interests).toEqual([]);
    });

    it('the match_request carries the authorised profile — withheld fields are removed', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
      selfA.profile.boundaries = {
        ...DEFAULT_SOCIAL_BOUNDARIES,
        allowBio: false,
        allowInterests: true,
        allowCurrentActivity: false,
        allowAvatar: false,
      };
      selfA.profile.avatar = 'data:image/png;base64,AAAA';

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      await acceptOnBothSides(sessionA, sessionB);
      // Both sides run phase 2 concurrently — running A alone would
      // leave it waiting out the 30s peer-analysis timeout.
      await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);

      const requests = outboundOfType(sentByA, 'match_request');
      expect(requests).toHaveLength(1);
      const selfProfile = (requests[0]!.payload as { selfProfile: SocialProfile }).selfProfile;
      expect(selfProfile.nickname).toBe('Alice');
      expect(selfProfile.bio).toBe('');
      expect(selfProfile.interests).toEqual(['typescript', 'reading']);
      expect(selfProfile.currentActivities).toEqual([]);
      // The avatar key is omitted entirely rather than sent empty.
      expect('avatar' in selfProfile).toBe(false);
    });

    it('nothing but the public card is sent before the consent', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      const sentByA = recordOutbound(sessionA);
      // The peer never answers the consent. The production default for
      // that wait is 60 s — the peer is a person deciding — so the test
      // shortens it to observe the refusal inside the 5 s test budget.
      // The length of the wait is not what is under test; the refusal
      // is. (The same knob is used by the "degraded LLM" and "no peer
      // match_response" tests below.)
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        peerConsentTimeoutMs: 200,
      });
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      // Phase 1 only: a hello and a public card. No authorised profile.
      expect(sentByA.map((m) => m.type)).toEqual(['hello', 'profile_exchange']);

      // Phase 2 is refused without the peer's consent — even though the
      // LOCAL record claims a mutual accept. The local record alone
      // cannot unlock the disclosure: the peer's `consent_accept` has
      // to be on the wire too.
      const refusal = await orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(ConsentRequiredError);
      expect((refusal as ConsentRequiredError).reason).toBe('peer-timeout');
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
    });

    it('exchangeAndMatch refuses without a mutual consent', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      // Only the local side accepted — the peer has not.
      await expect(
        orchA.exchangeAndMatch(sessionA, {
          state: 'accepted_local',
          peerAgentId: ID_B,
          bothAccepted: false,
        }),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
      expect(aStub.calls).toHaveLength(0);
    });

    it('exchangeAndMatch refuses a consent that belongs to a different peer', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      // A consent recorded for a *different* agent must not be
      // replayable against this one.
      await expect(
        orchA.exchangeAndMatch(sessionA, mutualConsent('33333333-4444-4555-8666-cccccccccccc')),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
    });

    it('exchangeAndMatch refuses when the peer rejected', async () => {
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      await sessionB.send(createConsentReject(ID_B, { reason: 'not interested' }));

      await expect(orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B))).rejects.toBeInstanceOf(
        ConsentRequiredError,
      );
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
    });

    it('a forged peer consent cannot widen the local authorisation', async () => {
      // Task book § 五 B2: 「对方伪造同意状态不能扩大本地授权范围」.
      //
      // The peer sends a `consent_accept` whose payload tries to grant
      // a wider disclosure. Two independent things stop it:
      //   1. the orchestrator reads only the envelope TYPE — the
      //      payload of a `consent_accept` is never consulted;
      //   2. the outbound filter reads only the LOCAL boundaries —
      //      `filterProfileForOutbound` never sees peer data.
      // So the local user's withheld bio stays withheld.
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
      selfA.profile.bio = 'ALICE-SECRET-BIO';
      selfA.profile.boundaries = {
        ...DEFAULT_SOCIAL_BOUNDARIES,
        allowBio: false,
        allowCurrentActivity: false,
      };

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      // The forged acceptance: an out-of-contract payload that tries to
      // authorise a wider disclosure.
      //
      // It really does reach the peer with the forged payload intact:
      // these test sessions have no signer, so `signOutbound` hands the
      // envelope through untouched (no `validateEnvelope` on the way
      // out, no signature check on the way in) — the test would be
      // vacuous if the forged bytes were stripped before delivery.
      const forged = {
        ...createConsentAccept(ID_B),
        payload: { note: 'ok', allowBio: true, shareEverything: true },
      } as unknown as KsaMessage;
      await sessionB.send(forged);
      // A's own acceptance is genuine — it is A's own decision, and it
      // says nothing about what A may disclose.
      await sessionA.send(createConsentAccept(ID_A));

      // Both sides run phase 2 concurrently: A finds B's (forged)
      // acceptance, B finds A's genuine one, and each answers with a
      // `match_response`. Running only A would leave A waiting out the
      // 30s peer-analysis timeout — this keeps the test fast.
      await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);

      const requests = outboundOfType(sentByA, 'match_request');
      expect(requests).toHaveLength(1);
      const selfProfile = (requests[0]!.payload as { selfProfile: SocialProfile }).selfProfile;
      // The forged grant changed nothing.
      expect(selfProfile.bio).toBe('');
      expect(selfProfile.currentActivities).toEqual([]);
      // The fields the local user DID authorise are still there — the
      // peer did not get a stripped-down profile either.
      expect(selfProfile.interests).toEqual(['typescript', 'reading']);
    });

    it('the analysis is computed from the authorised profile — a withheld bio never reaches the LLM', async () => {
      // The `match_response` is peer-visible. An analysis derived from
      // a withheld field would leak exactly what the user gated.
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
      selfA.profile.bio = 'ALICE-SECRET-BIO';
      selfA.profile.boundaries = {
        ...DEFAULT_SOCIAL_BOUNDARIES,
        allowBio: false,
      };

      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      await acceptOnBothSides(sessionA, sessionB);
      // Both sides run phase 2 concurrently so each one gets the
      // other's `match_response` — running A alone would leave it
      // waiting out the 30s peer-analysis timeout.
      await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);

      expect(aStub.calls).toHaveLength(1);
      const prompt = aStub.calls[0]!.map((m) => m.content).join('\n');
      expect(prompt).not.toContain('ALICE-SECRET-BIO');
    });

    it('a revocation between the phases is honoured (the boundaries are read at send time)', async () => {
      // Task book § 五 B2 requirement 8: 「用户撤销授权后，应阻止后续
      // 相关数据传输」. The boundaries are therefore read through a
      // callback at the moment of the send, not snapshotted up front.
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      let allowBio = true;
      const depsA = selfToDeps(selfA, undefined, () => ({
        ...selfA.profile.boundaries,
        allowBio,
      }));

      const sentByA = recordOutbound(sessionA);
      const orchA = new MatchOrchestrator(depsA, ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);

      // The user revokes the bio authorisation while the consent screen
      // is up.
      allowBio = false;

      await acceptOnBothSides(sessionA, sessionB);
      await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);

      const requests = outboundOfType(sentByA, 'match_request');
      expect(requests).toHaveLength(1);
      const selfProfile = (requests[0]!.payload as { selfProfile: SocialProfile }).selfProfile;
      expect(selfProfile.bio).toBe('');
    });
  });

  describe('Phase B / B3 — the block list', () => {
    it('refuses a peer that was blocked AFTER the consent but BEFORE the profile exchange', async () => {
      // Task book § 五 B3 requirement 7: 「对黑名单用户拒绝后续匹配请求」.
      //
      // The phase-1 guard only covers a peer that was already blocked
      // when the connection was made. A peer that the user blocks from
      // the consent screen (or from another window) must also be
      // refused before the authorised profile goes out — otherwise the
      // block would only stop the *next* pairing, while this one still
      // ships the bio.
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      // The user blocks B while the consent screen is up.
      let blocked = false;
      const depsA = selfToDeps(selfA, (id) => {
        if (blocked) throw new PeerBlockedError(id, 'blocked during the consent step');
      });

      const sentByA = recordOutbound(sessionA);
      const receivedByB = recordInbound(sessionB);
      const orchA = new MatchOrchestrator(depsA, ID_B);
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A);

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      blocked = true;

      await acceptOnBothSides(sessionA, sessionB);

      await expect(orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B))).rejects.toBeInstanceOf(
        PeerBlockedError,
      );

      // No authorised profile reached the blocked peer.
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
      expect(receivedByB.filter((m) => m.type === 'match_request')).toHaveLength(0);
      // The LLM was never called — there was nothing to analyse.
      expect(aStub.calls).toHaveLength(0);
      // And the session was torn down rather than left hanging.
      expect(sessionA.current().state).toBe('closed');
      expect(sessionA.current().closeReason).toBe('peer-blocked');
    });

    it('the block-list guard runs before the consent check, so nothing is sent either way', async () => {
      // Both guards must leave the wire clean. A blocked peer must not
      // even be told that the consent was missing — the refusal is
      // local.
      const { sessionA } = await makePair();
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM should not be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);

      let blocked = false;
      const sentByA = recordOutbound(sessionA);
      const orch = new MatchOrchestrator(
        selfToDeps(selfA, (id) => {
          if (blocked) throw new PeerBlockedError(id);
        }),
        ID_B,
      );

      await orch.identify(sessionA);
      blocked = true;
      await expect(
        orch.exchangeAndMatch(sessionA, {
          state: 'accepted_local',
          peerAgentId: ID_B,
          bothAccepted: false,
        }),
      ).rejects.toBeInstanceOf(PeerBlockedError);
      expect(outboundOfType(sentByA, 'match_request')).toHaveLength(0);
    });

    it('an unblocked peer still passes the phase-2 guard', async () => {
      // The guard must not fire on its own — a peer that is not on the
      // block list has to get through.
      const { sessionA, sessionB } = await makePair();
      const aStub = stubProvider(cannedAnalysis('strong'));
      const bStub = stubProvider(cannedAnalysis('moderate'));
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);

      let guardCalls = 0;
      const depsA = selfToDeps(selfA, () => {
        guardCalls += 1;
      });
      const orchA = new MatchOrchestrator(depsA, ID_B, {
        peerAnalysisTimeoutMs: 100,
        earlyWaitTimeoutMs: 50,
        peerConsentTimeoutMs: 500,
      });
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A, {
        peerAnalysisTimeoutMs: 100,
        earlyWaitTimeoutMs: 50,
        peerConsentTimeoutMs: 500,
      });

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      expect(guardCalls).toBe(1);

      await acceptOnBothSides(sessionA, sessionB);
      await orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B));
      // Called again in phase 2.
      expect(guardCalls).toBe(2);
    });
  });

  describe('Phase 15 — Agent handshake (TCP-connected ≠ handshake complete)', () => {
    // Helpers used in this block. `makeTcpConnectedPair` is like
    // `makePair({ handshake: false })` — both sessions are in
    // 'tcp-connected' state, no hello has been validated yet. Each
    // test then drives the orchestrator and asserts the handshake
    // semantics in isolation.
    async function makeTcpConnectedPair(): Promise<Pair> {
      return makePair({ handshake: false });
    }

    // Test-only transport pair that delivers messages WITHOUT going
    // through `decodeEnvelope`. Used to exercise the orchestrator's
    // own `validatePeerHello` defense-in-depth (the production wire
    // already rejects malformed envelopes; we want to verify the
    // orchestrator catches them too if a custom transport ever
    // delivered one).
    class RawPair {
      readonly handlers: Set<(m: KsaMessage) => void> = new Set();
      private peer: RawPair | null = null;
      private closeHandlers: Set<(reason: CloseReason) => void> = new Set();
      private closedByPeer = false;

      static pair(a: RawPair, b: RawPair): void {
        a.peer = b;
        b.peer = a;
      }

      async connect(_peer: {
        agentId: string;
        displayName: string;
        hint?: string;
      }): Promise<void> {}
      async send(message: KsaMessage): Promise<void> {
        if (this.peer) {
          for (const h of this.peer.handlers) h(message);
        }
      }
      onMessage(handler: (m: KsaMessage) => void): () => void {
        this.handlers.add(handler);
        return () => {
          this.handlers.delete(handler);
        };
      }
      /**
       * Phase 16.4: peer-close hook. By default never fires. Tests
       * that need to simulate a peer-side drop call
       * `simulatePeerClose()` directly.
       */
      onClose(handler: (reason: CloseReason) => void): () => void {
        this.closeHandlers.add(handler);
        if (this.closedByPeer) {
          queueMicrotask(() => {
            if (this.closedByPeer) {
              try {
                handler('peer-closed');
              } catch {
                // ignore — mirroring LanTransport's per-handler try/catch
              }
            }
          });
        }
        return () => {
          this.closeHandlers.delete(handler);
        };
      }
      async disconnect(): Promise<void> {
        if (this.peer) {
          this.peer.peer = null;
          this.peer = null;
        }
        // Local disconnect does NOT fire onClose (mirrors LanTransport).
        this.closeHandlers.clear();
      }
      /** Test-only: simulate an inbound message from the peer. */
      injectFromPeer(message: KsaMessage): void {
        for (const h of this.handlers) h(message);
      }
      /**
       * Phase 16.4: simulate a remote-side drop. Fires every
       * registered close handler once, mirrors LanTransport's
       * idempotency + best-effort teardown.
       */
      simulatePeerClose(): void {
        if (this.closedByPeer) return;
        this.closedByPeer = true;
        const handlers = Array.from(this.closeHandlers);
        for (const h of handlers) {
          try {
            h('peer-closed');
          } catch {
            // ignore
          }
        }
        this.peer = null;
      }
      /** Test-only: query the closed-by-peer flag. */
      wasClosedByPeer(): boolean {
        return this.closedByPeer;
      }
    }

    function makeHello(sender: string, displayName = 'Peer'): KsaMessage {
      // Build via the protocol builder so the wire shape is exact.
      return {
        protocol: 'KSA',
        version: '0.1',
        messageId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        timestamp: new Date().toISOString(),
        type: 'hello',
        sender,
        payload: {
          displayName,
          capabilities: {
            protocolVersion: '0.1',
            supportsMatchAnalysis: true,
            supportsIcebreaker: true,
            supportsChatAssist: true,
            supportsMessageSigning: false,
            supportsSessionEncryption: false,
            supportsTransportEncryption: false,
            supportsWebRtc: false,
          },
        },
      } as KsaMessage;
    }

    async function makeRawPairWithTcpConnectedSessions(): Promise<{
      sessionA: PairingSession;
      sessionB: PairingSession;
      transportA: RawPair;
      transportB: RawPair;
    }> {
      const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
      const sessionB = new PairingSession({ agentId: ID_B, displayName: 'Bob' });
      const transportA = new RawPair();
      const transportB = new RawPair();
      RawPair.pair(transportA, transportB);
      const code = sessionA.startHost(transportA);
      await sessionB.startJoin(transportB, code);
      // Both sessions need an explicit notifyTransportConnected
      // (RawPair's `connect` is a no-op).
      sessionA.notifyTransportConnected();
      sessionB.notifyTransportConnected();
      return { sessionA, sessionB, transportA, transportB };
    }

    // Suppress the unused-helper warning while keeping the helper
    // available for future tests that need a full two-sided
    // orchestrator pair against the mock transport.
    void makeRawPairWithTcpConnectedSessions;

    it('does NOT run analysis when the peer never sends a hello (handshake timeout)', async () => {
      const { sessionA } = await makeTcpConnectedPair();
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called — handshake should fail first');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), '', {
        peerAnalysisTimeoutMs: 50,
        earlyWaitTimeoutMs: 50,
        helloTimeoutMs: 80,
      });

      await expect(orch.identify(sessionA)).rejects.toBeInstanceOf(HandshakeTimeoutError);
      // Session was failed by the orchestrator — no LLM call, no
      // analysis. The session is now in 'closed' with the timeout
      // reason.
      expect(sessionA.current().state).toBe('closed');
      expect(sessionA.current().closeReason).toMatch(/hello-timeout|session-closed/);
    });

    it('completes the handshake when both sides exchange valid hellos', async () => {
      const { sessionA, sessionB } = await makeTcpConnectedPair();
      const llmA: LLMProvider = {
        async chat() {
          return { content: JSON.stringify(cannedAnalysis('strong')), model: 'stub' };
        },
      };
      const llmB: LLMProvider = {
        async chat() {
          return { content: JSON.stringify(cannedAnalysis('moderate')), model: 'stub' };
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const selfB = await makeSelf(ID_B, 'Bob', llmB);

      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        peerAnalysisTimeoutMs: 200,
        earlyWaitTimeoutMs: 100,
        helloTimeoutMs: 1000,
      });
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A, {
        peerAnalysisTimeoutMs: 200,
        earlyWaitTimeoutMs: 100,
        helloTimeoutMs: 1000,
      });

      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      // Both sides should reach 'connected' (handshake complete).
      expect(sessionA.current().state).toBe('connected');
      expect(sessionB.current().state).toBe('connected');
      expect(sessionA.current().peerAgentId).toBe(ID_B);
      expect(sessionB.current().peerAgentId).toBe(ID_A);

      await acceptOnBothSides(sessionA, sessionB);
      const [outA, outB] = await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);
      // And the analysis ran.
      expect(outA.localAnalysis.compatibilitySignal).toBe('strong');
      expect(outB.localAnalysis.compatibilitySignal).toBe('moderate');
    });

    it('rejects a hello envelope whose sender equals self (handshake does not complete)', async () => {
      // The orchestrator's isFromPeer filter is the first line of
      // defence — a self-addressed hello never reaches the
      // validatePeerHello check. The handshake still must NOT
      // complete: the orchestrator times out, throws, closes the
      // session, and does not call the LLM.
      const { sessionA } = await makeTcpConnectedPair();
      const selfHello = makeHello(ID_A);
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 50,
      });
      // Push the self-hello through the wire. The Loopback delivers
      // it to the other side, which has no orchestrator installed, so
      // the message is dropped. If it ever looped back to A's queue,
      // the isFromPeer filter would also reject it.
      await sessionA.send(selfHello);
      await expect(orch.identify(sessionA)).rejects.toBeInstanceOf(HandshakeTimeoutError);
      expect(sessionA.current().state).toBe('closed');
    });

    it('rejects a hello envelope whose sender is not a UUID (orchestrator-level validation)', async () => {
      // Uses a mock transport to bypass the wire's `validateEnvelope`,
      // which would normally reject a non-UUID sender. We want to
      // verify the orchestrator's own `validatePeerHello` catches
      // this even if a custom transport let it through.
      const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
      const transportA = new RawPair();
      sessionA.startHost(transportA);
      sessionA.notifyTransportConnected();
      const badHello = makeHello('not-a-uuid');
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), '', {
        helloTimeoutMs: 500,
      });
      // Start the orchestrator (registers its queue on the
      // transport), then inject the bad hello directly. The
      // orchestrator's queue sees the bad message, the
      // validatePeerHello check rejects it.
      const startPromise = orch.identify(sessionA);
      transportA.injectFromPeer(badHello);
      await expect(startPromise).rejects.toBeInstanceOf(HandshakeValidationError);
      expect(sessionA.current().state).toBe('closed');
    });

    it('rejects a malformed hello payload (missing displayName) (orchestrator-level validation)', async () => {
      // Mock transport: the wire's `validateEnvelope` would normally
      // reject this. We bypass to test the orchestrator's own
      // defense-in-depth.
      const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
      const transportA = new RawPair();
      sessionA.startHost(transportA);
      sessionA.notifyTransportConnected();
      const badHello: KsaMessage = {
        protocol: 'KSA',
        version: '0.1',
        messageId: 'f47ac10b-58cc-4372-a567-0e02b2c3d481',
        timestamp: new Date().toISOString(),
        type: 'hello',
        sender: ID_B,
        payload: {
          // displayName intentionally missing.
          capabilities: {
            protocolVersion: '0.1',
            supportsMatchAnalysis: true,
            supportsIcebreaker: true,
            supportsChatAssist: true,
            supportsMessageSigning: false,
            supportsSessionEncryption: false,
            supportsTransportEncryption: false,
            supportsWebRtc: false,
          },
        },
      } as unknown as KsaMessage;
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 500,
      });
      const startPromise = orch.identify(sessionA);
      transportA.injectFromPeer(badHello);
      await expect(startPromise).rejects.toBeInstanceOf(HandshakeValidationError);
      expect(sessionA.current().state).toBe('closed');
    });

    it('does not run analysis if the session is closed before hello arrives', async () => {
      const { sessionA } = await makeTcpConnectedPair();
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 1000,
      });

      // Start the orchestrator, then close the session mid-wait.
      const startPromise = orch.identify(sessionA);
      // Give the orchestrator a moment to enter the hello wait.
      await new Promise((r) => setTimeout(r, 20));
      await sessionA.disconnect('peer-disconnected');

      await expect(startPromise).rejects.toBeInstanceOf(HandshakeClosedError);
      expect(sessionA.current().state).toBe('closed');
    });

    // ---- Phase 16.4: peer-close is distinct from user-cancel / generic timeout ----

    it('throws HandshakeClosedError with "peer closed" message when transport fires onClose mid-wait', async () => {
      // Build a tcp-connected pair with explicit transport access.
      const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
      const transportA = new RawPair();
      sessionA.startHost(transportA);
      sessionA.notifyTransportConnected();
      let llmCalled = false;
      const llmA: LLMProvider = {
        async chat() {
          llmCalled = true;
          return { content: JSON.stringify(cannedAnalysis()), model: 'stub' };
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        // Long enough that the peer-close path triggers FIRST.
        // If the close path didn't fire, this test would still
        // pass (the orchestrator times out with
        // HandshakeTimeoutError), so we additionally assert that
        // the error is NOT a timeout.
        helloTimeoutMs: 5000,
      });

      // Attach the catch handler IMMEDIATELY so vitest's unhandled
      // rejection tracker doesn't fire before the test asserts.
      const settled: { value: unknown; error: unknown } = { value: undefined, error: undefined };
      const startPromise = orch.identify(sessionA).then(
        (v) => {
          settled.value = v;
        },
        (e: unknown) => {
          settled.error = e;
        },
      );
      // Give the orchestrator a moment to enter the hello wait.
      await new Promise((r) => setTimeout(r, 20));
      // Simulate the peer's TCP link dropping.
      transportA.simulatePeerClose();
      // Let the close handler run.
      await new Promise((r) => setTimeout(r, 20));
      await startPromise;

      expect(settled.error).toBeInstanceOf(HandshakeClosedError);
      // Phase 16.4: the message specifically mentions the peer
      // closing, not a generic "session closed" or "timed out".
      expect((settled.error as Error).message).toMatch(/peer closed/i);
      expect(settled.error).not.toBeInstanceOf(HandshakeTimeoutError);
      // LLM must NOT be called — the handshake never completed.
      expect(llmCalled).toBe(false);
      // Session is closed with the right reason.
      expect(sessionA.current().state).toBe('closed');
      expect(sessionA.current().closeReason).toBe('peer-closed');
    });

    it('does NOT classify a peer-close as a HandshakeTimeoutError', async () => {
      const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
      const transportA = new RawPair();
      sessionA.startHost(transportA);
      sessionA.notifyTransportConnected();
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 5000,
      });

      const settled: { error: unknown } = { error: undefined };
      const startPromise = orch.identify(sessionA).then(
        () => undefined,
        (e: unknown) => {
          settled.error = e;
        },
      );
      await new Promise((r) => setTimeout(r, 20));
      transportA.simulatePeerClose();
      await new Promise((r) => setTimeout(r, 20));
      await startPromise;

      expect(settled.error).toBeInstanceOf(HandshakeClosedError);
      expect(settled.error).not.toBeInstanceOf(HandshakeTimeoutError);
    });

    it('user-initiated disconnect still surfaces as HandshakeClosedError (existing behaviour preserved)', async () => {
      // Sanity check: the user-cancel path goes through
      // `session.disconnect('user-cancel')`, NOT through the
      // transport's onClose. The orchestrator should still throw
      // HandshakeClosedError, but with the user-cancel reason in
      // the snapshot — NOT the peer-closed reason.
      const { sessionA } = await makeTcpConnectedPair();
      const llmA: LLMProvider = {
        async chat() {
          throw new Error('LLM must NOT be called');
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 5000,
      });

      const settled: { error: unknown } = { error: undefined };
      const startPromise = orch.identify(sessionA).then(
        () => undefined,
        (e: unknown) => {
          settled.error = e;
        },
      );
      await new Promise((r) => setTimeout(r, 20));
      await sessionA.disconnect('user-cancel');
      await new Promise((r) => setTimeout(r, 20));
      await startPromise;

      expect(settled.error).toBeInstanceOf(HandshakeClosedError);
      // The reason in the snapshot is the user-cancel reason, NOT
      // 'peer-closed'. The error message may still mention the
      // generic "PairingSession closed" wording, but the snapshot
      // closeReason is the source of truth for the UI.
      expect(sessionA.current().closeReason).toBe('user-cancel');
    });

    it('host and joiner see symmetric handshake semantics (both must send and receive a valid hello)', async () => {
      const { sessionA, sessionB } = await makeTcpConnectedPair();
      const llmStub = () => stubProvider(cannedAnalysis('moderate'));
      const aStub = llmStub();
      const bStub = llmStub();
      const selfA = await makeSelf(ID_A, 'Alice', aStub.provider);
      const selfB = await makeSelf(ID_B, 'Bob', bStub.provider);
      const orchA = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        peerAnalysisTimeoutMs: 200,
        earlyWaitTimeoutMs: 100,
        helloTimeoutMs: 500,
      });
      const orchB = new MatchOrchestrator(selfToDeps(selfB), ID_A, {
        peerAnalysisTimeoutMs: 200,
        earlyWaitTimeoutMs: 100,
        helloTimeoutMs: 500,
      });
      await Promise.all([orchA.identify(sessionA), orchB.identify(sessionB)]);
      // Both ends reach 'connected' with the correct peer id.
      expect(sessionA.current().state).toBe('connected');
      expect(sessionB.current().state).toBe('connected');
      expect(sessionA.current().peerAgentId).toBe(ID_B);
      expect(sessionB.current().peerAgentId).toBe(ID_A);

      await acceptOnBothSides(sessionA, sessionB);
      const [outA, outB] = await Promise.all([
        orchA.exchangeAndMatch(sessionA, mutualConsent(ID_B)),
        orchB.exchangeAndMatch(sessionB, mutualConsent(ID_A)),
      ]);
      // Both LLM stubs were called.
      expect(aStub.calls).toHaveLength(1);
      expect(bStub.calls).toHaveLength(1);
      // The peer's analysis is the other side's LLM reply.
      expect(outA.peerAnalysis?.compatibilitySignal).toBe('moderate');
      expect(outB.peerAnalysis?.compatibilitySignal).toBe('moderate');
    });

    it('MatchOrchestrator does NOT run analyzeMatch if the handshake fails', async () => {
      const { sessionA } = await makeTcpConnectedPair();
      let llmCalled = false;
      const llmA: LLMProvider = {
        async chat() {
          llmCalled = true;
          return { content: JSON.stringify(cannedAnalysis()), model: 'stub' };
        },
      };
      const selfA = await makeSelf(ID_A, 'Alice', llmA);
      const orch = new MatchOrchestrator(selfToDeps(selfA), ID_B, {
        helloTimeoutMs: 50,
        peerAnalysisTimeoutMs: 50,
        earlyWaitTimeoutMs: 50,
      });
      await expect(orch.identify(sessionA)).rejects.toBeInstanceOf(HandshakeTimeoutError);
      expect(llmCalled).toBe(false);
      expect(sessionA.current().state).toBe('closed');
    });
  });
});
