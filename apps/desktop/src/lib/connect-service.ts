/**
 * Connect service — desktop glue for V0.1 Mode A pairing.
 *
 * Owns the lifecycle of a single pairing session: build a hub,
 * start a host or join flow, return an orchestrator that the view
 * can drive to get a match result, then a consent orchestrator for
 * the Phase 7 accept/reject/block decision.
 *
 * V0.1 limitation: discovery is in-process via `LoopbackHub`. Real
 * LAN / WebRTC discovery lands in Mode B / C (out of scope for V0.1).
 *
 * See 开发手册.md § 18, § 44, Phase 6 + Phase 7.
 */

import type { LLMProvider } from '@kindora/llm';
import {
  LoopbackHub,
  LoopbackTransport,
  PairingSession,
} from '@kindora/transport';
import {
  ChatAssistOrchestrator,
  ChatOrchestrator,
  ConsentOrchestrator,
  MatchOrchestrator,
  type ChatAssistHandle,
  type ChatAssistHistoryEntry,
  type ChatAssistOrchestratorOptions,
  type ChatOrchestratorOptions,
  type ChatSnapshot,
  type MatchOrchestratorSelf,
  type MatchOutcome,
} from '@kindora/matching';
import {
  generateIcebreaker,
  createAgentConfig,
  type GenerateIcebreakerConfig,
  type GenerateIcebreakerInput,
  type GenerateIcebreakerResult,
} from '@kindora/agent';
import {
  BrowserLocalStorageBlockedAgentsStore,
  type BlockedAgentsStore,
} from '@kindora/storage';
import type { SocialAgent, SocialProfile } from '@kindora/protocol';

const _hub = new LoopbackHub();
/** Single shared block list for the desktop app. */
const _blockList: BlockedAgentsStore = new BrowserLocalStorageBlockedAgentsStore();

export interface ConnectHandle {
  /** Code the host should share with the joiner (only set when mode === 'host'). */
  readonly pairingCode: string;
  /** Pairing session the orchestrator drives. */
  readonly session: PairingSession;
  /** Local agent id — needed for outgoing consent envelopes. */
  readonly selfAgentId: string;
  /**
   * Orchestrator built when the peer is known. The orchestrator's
   * `peerAgentId` is set to the actual peer id at the time the
   * joiner pairs with the host.
   */
  readonly orchestrator: MatchOrchestrator;
  /**
   * Whether the session is in the "hosting" / "joining" state vs
   * "connected". The view uses this to render the right intermediate
   * state. The host transitions to 'connected' as soon as the peer
   * joins; the joiner is 'connected' after `startJoin()` returns.
   */
  state: 'hosting' | 'joining' | 'connected';
  /** Tear down the session. Idempotent. */
  disconnect(reason?: string): Promise<void>;
}

export interface StartInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly profile: SocialProfile;
  readonly agent: SocialAgent;
  readonly llm: LLMProvider;
}

/**
 * Start a host pairing flow. The returned `pairingCode` is what the
 * joiner types/scans. The host immediately enters the room and
 * waits for the joiner to arrive; on arrival, the session
 * transitions to `connected`.
 */
export function startHost(input: StartInput): ConnectHandle {
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });
  const transport = new LoopbackTransport({ endpointId: input.agentId, hub: _hub });
  const pairingCode = session.startHost(transport);

  // The orchestrator is built lazily — its `peerAgentId` only
  // exists after the joiner has paired with us. Until then we
  // expose a placeholder.
  let orchestrator: MatchOrchestrator | null = null;

  // Poll for the peer joining. The hub delivers messages
  // synchronously; if a joiner arrives, the transport's `connected`
  // flag flips to `true` on the next microtask. We poll a few times
  // via `setTimeout(0)` to give the joiner a chance to land.
  const pollHandle = setInterval(() => {
    if (transport.isConnected() && session.current().state === 'hosting') {
      if (!orchestrator) {
        // Empty peer id — the orchestrator will learn it from the
        // first incoming `hello` or `profile_exchange` envelope.
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      session.notifyPeerConnected();
      clearInterval(pollHandle);
    }
    if (session.current().state === 'closed') {
      clearInterval(pollHandle);
    }
  }, 50);

  const handle: ConnectHandle = {
    pairingCode,
    session,
    selfAgentId: input.agentId,
    get orchestrator() {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      return orchestrator;
    },
    state: 'hosting',
    async disconnect(reason: string = 'user-requested') {
      clearInterval(pollHandle);
      await session.disconnect(reason);
    },
  };

  // Mirror state changes onto the handle.
  session.onStateChange((snap) => {
    if (snap.state === 'connected' || snap.state === 'closed') {
      handle.state = snap.state === 'closed' ? 'joining' : 'connected';
    }
  });

  return handle;
}

/**
 * Start a joiner pairing flow. The join is attempted immediately;
 * if the host is in the room, the session becomes `connected` on
 * the next microtask.
 */
export function startJoin(input: StartInput & { code: string }): ConnectHandle {
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });
  const transport = new LoopbackTransport({ endpointId: input.agentId, hub: _hub });
  // The orchestrator is built lazily — the joiner learns the host's
  // agent id from the host's `hello` envelope at run time.
  let orchestrator: MatchOrchestrator | null = null;

  // Fire-and-forget: startJoin resolves to 'connected' on the next
  // microtask. We mirror the new state onto the handle.
  const joinPromise = session.startJoin(transport, input.code).then(() => {
    handle.state = 'connected';
  });

  const handle: ConnectHandle = {
    pairingCode: input.code,
    session,
    selfAgentId: input.agentId,
    get orchestrator() {
      if (!orchestrator) {
        // Empty peer id — the orchestrator will learn it from the
        // first incoming `hello` or `profile_exchange` envelope.
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      return orchestrator;
    },
    state: 'joining',
    async disconnect(reason: string = 'user-requested') {
      await joinPromise.catch(() => undefined);
      await session.disconnect(reason);
    },
  };

  return handle;
}

/** Run the match orchestrator and return the outcome. */
export async function runMatch(handle: ConnectHandle): Promise<MatchOutcome> {
  if (handle.state !== 'connected' && handle.session.current().state !== 'connected') {
    throw new Error(
      `connect-service.runMatch: session is not connected (state=${handle.session.current().state}). Wait for the peer to join first.`,
    );
  }
  return handle.orchestrator.start(handle.session);
}

/* ------------------------------------------------------------------ */
/* Phase 7 — Consent                                                  */
/* ------------------------------------------------------------------ */

export interface ConsentHandle {
  /** Underlying pairing session — drives the consent envelopes. */
  readonly session: PairingSession;
  /** The peer's id (locked in by the time the match completed). */
  readonly peerAgentId: string;
  /** The peer's display name. */
  readonly peerDisplayName: string;
  /** Local consent orchestrator — the underlying state machine. */
  readonly orchestrator: ConsentOrchestrator;
}

/**
 * Start the consent phase after a successful match. The returned
 * handle exposes the consent orchestrator; the caller's `start()`
 * promise resolves when the flow reaches a terminal state. The
 * caller wires `decide()` from `ConsentOrchestrator.decide`.
 */
export function runConsent(handle: ConnectHandle, matchOutcome: MatchOutcome): ConsentHandle {
  const orchestrator = new ConsentOrchestrator({
    selfAgentId: handle.selfAgentId,
    peerDisplayName: matchOutcome.peerDisplayName,
    peerAgentId: matchOutcome.peerAgentId,
    options: { blockList: _blockList },
  });
  return {
    session: handle.session,
    peerAgentId: matchOutcome.peerAgentId,
    peerDisplayName: matchOutcome.peerDisplayName,
    orchestrator,
  };
}

/** Convenience: read the current block list (re-exported for views / settings). */
export function getBlockedAgentsStore(): BlockedAgentsStore {
  return _blockList;
}

/** Throw if `peerAgentId` is on the local block list. */
export async function assertPeerNotBlocked(peerAgentId: string): Promise<void> {
  if (await _blockList.has(peerAgentId)) {
    throw new Error('This agent is on your block list. Pairing refused.');
  }
}

/* ------------------------------------------------------------------ */
/* Phase 8 — Icebreaker                                                */
/* ------------------------------------------------------------------ */

export interface IcebreakerHandle {
  /** Input handed to the LLM (built from the local agent + match outcome). */
  readonly input: GenerateIcebreakerInput;
  /** Async function that runs a fresh LLM round-trip. */
  readonly generate: () => Promise<GenerateIcebreakerResult>;
  /** Runtime config (token budget) — exposed for tests. */
  readonly config: GenerateIcebreakerConfig;
}

/**
 * Build a Phase 8 icebreaker handle from a successful match.
 *
 * Loads the local agent + LLM provider, packages the two profiles plus
 * the local match analysis as a `GenerateIcebreakerInput`, and returns
 * a `generate()` runner the view can call (or re-call for Regenerate).
 *
 * Per 开发手册.md § 28–29: the AI only SUGGESTS — the human reviews
 * before sending. The returned runner NEVER auto-sends anything.
 */
export async function runIcebreaker(matchOutcome: MatchOutcome): Promise<IcebreakerHandle> {
  const [agent, llm] = await Promise.all([loadAgent(), loadProvider()]);
  if (!agent) {
    throw new Error('No agent on this device. Create an agent first.');
  }
  if (!llm) {
    throw new Error('No LLM configured. Open Settings and pick a provider.');
  }

  const config = createAgentConfig();
  const peerProfile = matchOutcome.peerProfile ?? minimalPeerProfile(matchOutcome.peerDisplayName);

  const input: GenerateIcebreakerInput = {
    selfProfile: agent.profile,
    selfDisplayName: agent.displayName,
    peerProfile,
    peerDisplayName: matchOutcome.peerDisplayName,
    analysis: matchOutcome.localAnalysis,
  };

  return {
    input,
    config,
    generate: () => generateIcebreaker(llm, input, config),
  };
}

/** Minimal fallback when the peer sent no profile_exchange (matches the orchestrator's). */
function minimalPeerProfile(displayName: string): SocialProfile {
  return {
    nickname: displayName,
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: [],
    conversationStyle: [],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Phase 9 — Chat                                                      */
/* ------------------------------------------------------------------ */

export interface ChatHandle {
  /** Underlying orchestrator — start()/send()/disconnect()/block(). */
  readonly orchestrator: ChatOrchestrator;
  /** Subscribe to snapshot updates. */
  readonly subscribe: (listener: (snap: ChatSnapshot) => void) => () => void;
  /** Snapshot accessor. */
  readonly snapshot: () => ChatSnapshot;
  /**
   * Optional pre-composed first message (e.g. the icebreaker the user
   * chose via "Use"). The chat view shows it in the input box on mount.
   */
  readonly firstMessage: string;
}

/**
 * Build a Phase 9 chat handle from a successful consent outcome.
 *
 * Returns a `ChatOrchestrator` configured with the local block list.
 * The orchestrator's `start()` is invoked by the caller (the view).
 * `subscribe()` is exposed so the view can react to incoming messages
 * and close events without owning the queue itself.
 */
export function runChat(
  handle: ConnectHandle,
  consentOutcome: ConsentOutcomeLike,
  firstMessage: string = '',
): ChatHandle {
  const options: ChatOrchestratorOptions = {
    blockList: _blockList,
  };
  const orchestrator = new ChatOrchestrator({
    selfAgentId: handle.selfAgentId,
    peerAgentId: consentOutcome.peerAgentId,
    peerDisplayName: consentOutcome.peerDisplayName,
    options,
  });
  return {
    orchestrator,
    subscribe: (listener) => orchestrator.subscribe(listener),
    snapshot: () => orchestrator.snapshot(),
    firstMessage,
  };
}

/**
 * Minimal shape we need from a ConsentOutcome to build a chat handle.
 * Keeping this loose so the call site doesn't have to depend on the
 * full ConsentOutcome shape.
 */
type ConsentOutcomeLike = Pick<MatchOutcome, 'peerAgentId' | 'peerDisplayName'>;

/* ------------------------------------------------------------------ */
/* Phase 10 — Ask My Agent                                             */
/* ------------------------------------------------------------------ */

export { type ChatAssistHandle } from '@kindora/matching';

/**
 * Build a Phase 10 chat-assist handle from a live chat handle + the
 * current consent outcome.
 *
 * The chat-assist orchestrator is read-only with respect to the wire —
 * it never sends chat_messages, blocks, or disconnects. It only calls
 * the LLM to produce suggestions that the human reviews (per § 32 the
 * agent never auto-sends).
 *
 * The `getHistory()` accessor pulls the live `ChatOrchestrator`
 * snapshot's entries on every call, so the assistant always sees the
 * freshest transcript. When no chat handle is provided (e.g. the
 * consent screen's catch path), the history accessor returns `[]` and
 * the assistant can still help based on profiles + analysis.
 */
export async function runChatAssist(
  chat: ChatHandle | null,
  consentOutcome: ConsentOutcomeLike,
  matchOutcome: MatchOutcome | null,
): Promise<ChatAssistHandle> {
  const [agent, llm] = await Promise.all([loadAgent(), loadProvider()]);
  if (!agent) {
    throw new Error('No agent on this device. Create an agent first.');
  }
  if (!llm) {
    throw new Error('No LLM configured. Open Settings and pick a provider.');
  }

  const config = createAgentConfig();
  const peerProfile = matchOutcome?.peerProfile ?? null;
  const options: ChatAssistOrchestratorOptions = {};

  const getHistory = (): readonly ChatAssistHistoryEntry[] =>
    chat ? chat.snapshot().entries : [];

  const orchestrator = new ChatAssistOrchestrator({
    selfAgentId: agent.agentId,
    selfProfile: agent.profile,
    peerDisplayName: consentOutcome.peerDisplayName,
    peerProfile,
    analysis: matchOutcome?.localAnalysis ?? null,
    llm,
    config,
    getHistory,
    options,
  });

  return { orchestrator };
}

function toOrchestratorSelf(input: StartInput): MatchOrchestratorSelf {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    profile: input.profile,
    agent: input.agent,
    capabilities: input.agent.capabilities,
    llm: input.llm,
    peerGuard: (peerAgentId: string) => {
      // Sync check is fine — the in-memory store is fast enough.
      // We throw to short-circuit the match; the orchestrator catches
      // and surfaces a 'none' analysis with peerRefused=true.
      if (peerAgentId && syncHas(peerAgentId)) {
        throw new Error('peer-blocked');
      }
    },
  };
}

/**
 * Synchronous `has` check against the in-memory snapshot of the
 * block list. The block list is in-memory backed by localStorage; the
 * read is a Map lookup so it's safe to call from a sync peer guard.
 */
let _blockedSnapshot: ReadonlySet<string> = new Set();
void _blockList.list().then((entries) => {
  _blockedSnapshot = new Set(entries.map((e) => e.agentId));
});
function syncHas(id: string): boolean {
  return _blockedSnapshot.has(id);
}

/** Refresh the in-memory snapshot — call after `add`/`remove` to keep the guard in sync. */
export async function refreshBlockListSnapshot(): Promise<void> {
  const entries = await _blockList.list();
  _blockedSnapshot = new Set(entries.map((e) => e.agentId));
}

/* ------------------------------------------------------------------ */
/* Desktop glue — read the local agent + LLM provider from stores     */
/* ------------------------------------------------------------------ */

import { loadAgent } from './agent-service';
import { loadProvider } from './llm-service';

/**
 * Build a `StartInput` from the local store. Throws if the agent
 * or LLM is not yet configured. Used by the ConnectView to drive
 * both host and join flows from a single source of truth.
 */
export async function toConnectInput(): Promise<StartInput> {
  const [agent, llm] = await Promise.all([loadAgent(), loadProvider()]);
  if (!agent) {
    throw new Error('No agent on this device. Create an agent first.');
  }
  if (!llm) {
    throw new Error('No LLM configured. Open Settings and pick a provider.');
  }
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    profile: agent.profile,
    agent: {
      agentId: agent.agentId,
      protocolVersion: agent.protocolVersion,
      displayName: agent.displayName,
      publicKey: agent.publicKey,
      profile: agent.profile,
      capabilities: agent.capabilities,
    },
    llm,
  };
}
