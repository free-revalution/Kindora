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
  derivePairingFingerprint,
  normalisePairingCode,
  PAIRING_FINGERPRINT_LENGTH,
  type ConnectionState,
  type ConnectionStateHandler,
} from '@kindora/transport';
import {
  ChatAssistOrchestrator,
  ChatOrchestrator,
  ConsentOrchestrator,
  MatchOrchestrator,
  PeerBlockedError,
  type ChatAssistHandle,
  type ChatAssistHistoryEntry,
  type ChatAssistOrchestratorOptions,
  type ChatMessageSource,
  type ChatOrchestratorOptions,
  type ChatPersistence,
  type ChatSnapshot,
  type LocalConsent,
  type MatchOrchestratorSelf,
  type MatchOutcome,
  type PeerIntroduction,
} from '@kindora/matching';
import {
  createEnvelopeSigner,
  generateIcebreaker,
  createAgentConfig,
  type GenerateIcebreakerConfig,
  type GenerateIcebreakerInput,
  type GenerateIcebreakerResult,
} from '@kindora/agent';
import { type BlockedAgentsStore } from '@kindora/storage';
import {
  base64ToBytes,
  resolveBoundaries,
  type EnvelopeSigner,
  type SocialAgent,
  type SocialProfile,
} from '@kindora/protocol';

import { DesktopChatPersistence } from './chat-persistence';
import { getKindoraDatabase, isDatabaseAvailable } from './database';
import { runtimeBlockedAgentsStore } from './runtime-stores';

const _hub = new LoopbackHub();
/**
 * Single shared block list for the desktop app.
 *
 * Phase D / D1 — the block list lives in the local business database
 * in the desktop app, and in localStorage in the browser dev server.
 */
const _blockList: BlockedAgentsStore = runtimeBlockedAgentsStore();

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
   * Whether the session is in the "hosting" / "joining" state, the
   * "tcp-connected" intermediate (wire is up, peer's `hello` not yet
   * validated), or the fully "connected" state (peer `hello` validated
   * and the orchestrator has been driven). The view uses this to
   * render the right intermediate state. The host transitions to
   * 'tcp-connected' as soon as the peer joins; the joiner is
   * 'tcp-connected' after `startJoin()` returns. The orchestrator
   * promotes either side to 'connected' once the peer's `hello` has
   * been received and validated.
   */
  state: 'hosting' | 'joining' | 'tcp-connected' | 'connected';
  /**
   * Phase C / C3 § 1 + § 8 — the connection lifecycle, when the
   * transport can report one.
   *
   * Optional on purpose: the in-process loopback transport has no
   * "the peer went away" event, so the loopback path leaves this
   * unset and the UI falls back to the pairing FSM's own state. The
   * LAN path fills it in from the `ConnectionStateMachine` the
   * `lan-connect-service` owns.
   */
  readonly connectionState?: () => ConnectionState;
  /**
   * Phase C / C3 § 8 — subscribe to connection-state changes.
   * Returns an unsubscribe function.
   */
  readonly onConnectionStateChange?: (handler: ConnectionStateHandler) => () => void;
  /**
   * Phase C / C3 § 3 — pair again after the link dropped.
   *
   * The reconnect rebuilds the session and the transport from scratch,
   * so the identity check and the secure handshake are redone — see
   * `PairingSession.resetForReconnect`.
   */
  readonly reconnect?: () => Promise<void>;
  /** Tear down the session. Idempotent. */
  disconnect(reason?: string): Promise<void>;
}

export interface StartInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly profile: SocialProfile;
  readonly agent: SocialAgent;
  readonly llm: LLMProvider;
  /**
   * Phase A / A2 — the signer for outbound envelopes.
   *
   * `null` when the runtime has no usable WebCrypto, in which case the
   * session runs unsigned (and says so through the capability flags).
   */
  readonly signer: EnvelopeSigner | null;
  /**
   * Phase A / A3 — this agent's pairing fingerprint: the six-character
   * identity code derived from its own public key.
   *
   * The host shows it and the joiner types it. It is an **identity
   * fingerprint**, not a password: it grants no access on its own, it
   * only lets the joiner confirm that the peer really is the host the
   * user was shown.
   */
  readonly fingerprint: string;
}

/**
 * Start a host pairing flow. The returned `pairingCode` is what the
 * joiner types/scans. The host immediately enters the room and
 * waits for the joiner to arrive; on arrival, the session
 * transitions to `connected`.
 *
 * Phase A / A3: the "code" is this agent's **identity fingerprint**
 * (derived from its own public key), not a random secret. It is both
 * the room key and the out-of-band assertion the joiner checks.
 */
export function startHost(input: StartInput): ConnectHandle {
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
    signer: input.signer,
  });
  const transport = new LoopbackTransport({ endpointId: input.agentId, hub: _hub });
  // Phase A / A3 — seed the pairing code with the identity
  // fingerprint so the joiner, who typed exactly this string, lands in
  // the right room. `generatePairingCode` validates the shape, so a
  // malformed fingerprint fails loudly here rather than silently
  // creating an unreachable room.
  const pairingCode = session.startHost(transport, { seed: input.fingerprint });

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

  // Mirror state changes onto the handle. Phase 15 surfaces
  // 'tcp-connected' (wire up, peer `hello` not yet validated) as a
  // distinct intermediate so the UI can show the new state honestly
  // before the orchestrator drives the handshake to 'connected'.
  session.onStateChange((snap) => {
    if (snap.state === 'hosting' || snap.state === 'joining') {
      handle.state = snap.state;
    } else if (snap.state === 'tcp-connected') {
      handle.state = 'tcp-connected';
    } else if (snap.state === 'connected') {
      handle.state = 'connected';
    } else if (snap.state === 'closed') {
      // Closed has no dedicated handle state — the view treats the
      // session as disconnected. Keep the last non-terminal state for
      // the UI to render an error message.
      handle.state = 'joining';
    }
  });

  return handle;
}

/**
 * Start a joiner pairing flow. The join is attempted immediately;
 * if the host is in the room, the session becomes `connected` on
 * the next microtask.
 *
 * Phase A / A3: the typed code is the **host's identity fingerprint**.
 * It is passed to the session as `expectedPeerFingerprint`, so the
 * handshake aborts with `closeReason = 'peer-fingerprint-mismatch'`
 * when the peer that answers does not hash to the code the user was
 * shown.
 */
export function startJoin(input: StartInput & { code: string }): ConnectHandle {
  const normalised = requireFingerprint(input.code);
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
    signer: input.signer,
    expectedPeerFingerprint: normalised,
  });
  const transport = new LoopbackTransport({ endpointId: input.agentId, hub: _hub });
  // The orchestrator is built lazily — the joiner learns the host's
  // agent id from the host's `hello` envelope at run time.
  let orchestrator: MatchOrchestrator | null = null;

  // Fire-and-forget: startJoin resolves to 'tcp-connected' on the next
  // microtask (Phase 15: the session does NOT auto-promote to
  // 'connected' — the orchestrator drives the `hello` exchange and
  // lifts it to 'connected'). We mirror the new state onto the
  // handle, mapping the full PairingState to the handle's narrower
  // shape (the handle never reports 'idle' / 'closed' as live states).
  const joinPromise = session.startJoin(transport, normalised).then(() => {
    const snap = session.current();
    if (snap.state === 'tcp-connected' || snap.state === 'connected') {
      handle.state = snap.state;
    }
  });

  const handle: ConnectHandle = {
    pairingCode: normalised,
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

/* ------------------------------------------------------------------ */
/* Phase B — two-phase match: identify → consent → exchangeAndMatch    */
/* ------------------------------------------------------------------ */

/**
 * Phase 1 — identify the peer.
 *
 * Sends the local `hello` and the **minimal public card**, refuses a
 * blocked peer **before** any profile data leaves the device, and
 * returns what the consent screen needs: the peer's id, display name
 * and public card.
 *
 * Nothing beyond the card may be sent here. The authorised profile is
 * only sent by `runExchangeAndMatch`, and only once both sides have
 * accepted.
 */
export async function runIdentify(handle: ConnectHandle): Promise<PeerIntroduction> {
  // The orchestrator can drive the full flow from either
  // 'tcp-connected' (it will perform the `hello` exchange itself) or
  // 'connected' (the exchange was already validated). We check the
  // session directly because `handle.state` is a snapshot that can
  // lag behind the source-of-truth session.
  const state = handle.session.current().state;
  if (state !== 'connected' && state !== 'tcp-connected') {
    throw new Error(
      `connect-service.runIdentify: session is not connected (state=${state}). Wait for the peer to join first.`,
    );
  }
  return handle.orchestrator.identify(handle.session);
}

/**
 * Phase 2 — exchange the **authorised** profile and run the analysis.
 *
 * `consent` is the local consent outcome. The orchestrator refuses to
 * send anything unless it is a mutual, peer-specific accept — and
 * unless the peer's own `consent_accept` is on the wire. A caller
 * cannot skip the consent step by accident: there is no code path
 * from `runIdentify` to this function that bypasses the check.
 */
export async function runExchangeAndMatch(
  handle: ConnectHandle,
  consent: LocalConsent,
): Promise<MatchOutcome> {
  const state = handle.session.current().state;
  if (state !== 'connected' && state !== 'tcp-connected') {
    throw new Error(
      `connect-service.runExchangeAndMatch: session is not connected (state=${state}).`,
    );
  }
  return handle.orchestrator.exchangeAndMatch(handle.session, consent);
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
 * Start the consent phase after the public card has been exchanged.
 *
 * The returned handle exposes the consent orchestrator; the caller's
 * `start()` promise resolves when the flow reaches a terminal state. The
 * caller wires `decide()` from `ConsentOrchestrator.decide`.
 *
 * Phase B: the peer's identity comes from the **peer introduction**
 * (phase 1), not from a match outcome — at consent time no analysis
 * exists yet, and the consent screen shows the public card.
 */
export function runConsent(handle: ConnectHandle, intro: PeerIntroduction): ConsentHandle {
  const orchestrator = new ConsentOrchestrator({
    selfAgentId: handle.selfAgentId,
    peerDisplayName: intro.peerDisplayName,
    peerAgentId: intro.peerAgentId,
    options: { blockList: _blockList },
  });
  return {
    session: handle.session,
    peerAgentId: intro.peerAgentId,
    peerDisplayName: intro.peerDisplayName,
    orchestrator,
  };
}

/** Convenience: read the current block list (re-exported for views / settings). */
export function getBlockedAgentsStore(): BlockedAgentsStore {
  return _blockList;
}

/**
 * Throw if `peerAgentId` is on the local block list.
 *
 * Phase B: this reads the **store**, not an in-memory snapshot. The
 * old snapshot was taken once at module load, so an agent blocked
 * during the session was not refused — the guard silently allowed the
 * peer it was supposed to reject.
 */
export async function assertPeerNotBlocked(peerAgentId: string): Promise<void> {
  if (!peerAgentId) return;
  if (await _blockList.has(peerAgentId)) {
    throw new PeerBlockedError(peerAgentId);
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

/**
 * Minimal fallback when the peer sent no profile_exchange (matches the
 * orchestrator's).
 *
 * Phase B: the boundaries come from the protocol defaults rather than
 * a hand-written literal, so a silent peer is treated exactly like a
 * peer that sent the conservative default card.
 */
function minimalPeerProfile(displayName: string): SocialProfile {
  return {
    nickname: displayName,
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: [],
    conversationStyle: [],
    boundaries: resolveBoundaries(),
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
  /**
   * Who composed {@link firstMessage}.
   *
   * The icebreaker is written by the LLM, so it is `agent`; an empty
   * draft is `human`. The value is recorded with the message when the
   * user sends it.
   */
  readonly firstMessageSource: ChatMessageSource;
  /**
   * Phase D / D2 — the id of the persisted conversation.
   *
   * `null` when the runtime has no local database (the browser dev
   * server), where the chat is not persisted at all.
   */
  readonly sessionId: string | null;
}

/**
 * Build a Phase 9 chat handle from a successful consent outcome.
 *
 * Returns a `ChatOrchestrator` configured with the local block list.
 * The orchestrator's `start()` is invoked by the caller (the view).
 * `subscribe()` is exposed so the view can react to incoming messages
 * and close events without owning the queue itself.
 *
 * Phase D / D2: when the runtime has a local database, the
 * orchestrator writes every message through it, so the conversation
 * survives a restart. The database is resolved lazily (the first
 * message), and a runtime without a database simply runs in memory.
 */
export function runChat(
  handle: ConnectHandle,
  consentOutcome: ConsentOutcomeLike,
  firstMessage: string = '',
  firstMessageSource: ChatMessageSource = 'human',
): ChatHandle {
  const persistence = createChatPersistence(handle, consentOutcome);
  const options: ChatOrchestratorOptions = {
    blockList: _blockList,
    ...(persistence
      ? { persistence: persistence.persistence, sessionId: persistence.sessionId }
      : {}),
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
    firstMessageSource,
    sessionId: persistence ? persistence.sessionId : null,
  };
}

/**
 * Phase D / D2 — the persistence for this chat, or `null` when the
 * runtime has no local database.
 */
function createChatPersistence(
  handle: ConnectHandle,
  consentOutcome: ConsentOutcomeLike,
): { persistence: ChatPersistence; sessionId: string } | null {
  if (!isDatabaseAvailable()) return null;
  const adapter = new DesktopChatPersistence({
    selfAgentId: handle.selfAgentId,
    peerAgentId: consentOutcome.peerAgentId,
    peerDisplayName: consentOutcome.peerDisplayName,
    database: () => getKindoraDatabase(),
  });
  return { persistence: adapter, sessionId: adapter.id };
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

  const getHistory = (): readonly ChatAssistHistoryEntry[] => (chat ? chat.snapshot().entries : []);

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
    peerGuard: async (peerAgentId: string) => {
      // Phase B: the guard runs in phase 1, **before** the public card
      // is sent. It reads the block-list store directly — the old
      // in-memory snapshot was taken once at module load, so an agent
      // blocked during the session slipped through.
      //
      // A store failure is NOT treated as "allowed": the error travels
      // out of the guard and the pairing is refused.
      await assertPeerNotBlocked(peerAgentId);
    },
    boundaries: async () => {
      // Phase B requirement 8 — read the boundaries that are in force
      // **right now**, so a revocation the user makes while the
      // session is open takes effect on the next send.
      //
      // If the store cannot be read (a locked keychain, no
      // localStorage), we fall back to the copy captured when the
      // session started rather than failing the whole pairing. The
      // snapshot is still the user's own last saved choice, and
      // failing here would take down a flow that has nothing to do
      // with the keychain.
      try {
        const agent = await loadAgent();
        if (agent) return agent.profile.boundaries;
      } catch (err: unknown) {
        console.error(
          'Kindora: could not re-read the privacy boundaries; using the ones captured when the session started.',
          err,
        );
      }
      return input.profile.boundaries;
    },
  };
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
    signer: await buildSigner(agent),
    fingerprint: await derivePairingFingerprint(agent.agentId, base64ToBytes(agent.publicKey)),
  };
}

/**
 * Phase A / A2 — build the envelope signer for the local agent.
 *
 * `loadAgent()` attaches the private key in memory (it lives in the OS
 * keychain in the shipped app). The signer imports it as a
 * **non-extractable** WebCrypto key, so from that point on the raw key
 * bytes cannot be read back out — only used to sign.
 *
 * Returns `null` when the runtime has no usable WebCrypto: the
 * session then runs unsigned, and the capability flags say so. A
 * signer that silently did nothing would be worse than none.
 */
export async function buildSigner(agent: {
  readonly agentId: string;
  readonly publicKey: string;
  readonly privateKey?: string;
}): Promise<EnvelopeSigner | null> {
  if (!agent.privateKey) return null;
  try {
    return await createEnvelopeSigner({
      agentId: agent.agentId,
      publicKey: agent.publicKey,
      privateKey: agent.privateKey,
    });
  } catch {
    // No usable WebCrypto (or a corrupt key). The capability flags
    // already report `supportsMessageSigning: false` in that case;
    // silently pretending to sign would be worse.
    return null;
  }
}

/**
 * Phase A / A3 — validate that the typed code is a well-formed
 * identity fingerprint.
 *
 * The fingerprint is always exactly six Crockford characters. A code
 * of a different length cannot be a fingerprint, so we reject it up
 * front with a message that says what to do, instead of letting the
 * user wait for a LAN discovery timeout.
 */
export function requireFingerprint(code: string): string {
  const normalised = normalisePairingCode(code);
  if (!normalised) {
    throw new Error(
      'That is not a valid identity fingerprint. It is six characters from the alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ.',
    );
  }
  if (normalised.length !== PAIRING_FINGERPRINT_LENGTH) {
    throw new Error(
      `An identity fingerprint is exactly ${PAIRING_FINGERPRINT_LENGTH} characters (got ${normalised.length}).`,
    );
  }
  return normalised;
}
