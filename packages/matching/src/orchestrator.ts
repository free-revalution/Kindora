/**
 * MatchOrchestrator — drives the KSA wire flow on top of a
 * `PairingSession` whose transport is up.
 *
 * ## Phase B (2026-11-05) — the flow is now TWO-PHASE
 *
 * Before Phase B a single `start()` did everything in one go:
 *
 *   hello → profile_exchange (FULL profile) → match_request (FULL profile again) → analysis
 *
 * That shipped the user's complete profile to a peer **before** the
 * human consent step, shipped it **twice** (once as `payload.profile`
 * and once nested in `payload.agent.profile`, then a third time as
 * `match_request.selfProfile`), and ran the block-list guard only
 * *after* the profile had already left the device.
 *
 * Task book § 五 B2 requires the opposite order:
 *
 *   1. `identify()`         — hello, then the **minimal public card**
 *   2. human consent       — the desktop shows the card, the user decides
 *   3. `exchangeAndMatch()` — the **authorised profile**, then the analysis
 *
 * `start()` is gone on purpose. With a single entry point a caller
 * could skip the consent step, and the whole point of Phase B is that
 * the consent step *cannot* be skipped: `exchangeAndMatch()` refuses to
 * send the authorised profile without a peer-specific, mutual consent.
 *
 * ## What is on the wire, and when
 *
 * | stage | envelope | profile content |
 * |---|---|---|
 * | `identify()` | `hello` | none (display name + capabilities only) |
 * | `identify()` | `profile_exchange` | the **public card** (nickname + authorised social intent / conversation style) |
 * | `exchangeAndMatch()` | `match_request` | the **authorised profile** (every field the user did not authorise removed) |
 * | `exchangeAndMatch()` | `match_response` | the analysis (computed from the authorised profiles only) |
 *
 * The public card is built by `buildPublicCard` and the authorised
 * profile by `filterProfileForOutbound` — both live in
 * `@kindora/protocol`'s `profile-privacy-filter`. This module never
 * builds a profile itself; it only decides *when* to send which one
 * and asserts, immediately before the send, that the copy really does
 * respect the user's authorisation.
 *
 * ## The invariant this module upholds
 *
 * **A peer's message can never widen the local user's authorisation.**
 *
 * Every filter decision reads the **local** boundaries. The peer's
 * `consent_accept` is treated as *evidence that the peer agreed*, never
 * as *permission for us to disclose more* — the disclosure scope is
 * fixed by the local user before the peer is even known.
 *
 * ## Implementation note — multiple handlers on one session
 *
 * `PairingSession.onMessage` supports **multiple** simultaneous
 * handlers (it is a `Set`, and it returns an unsubscribe function).
 * The `ConsentOrchestrator` installs its own queue on the same
 * session, and both queues see every inbound envelope. That is what
 * lets the MatchOrchestrator's queue survive the phase-1 → consent →
 * phase-2 gap: the peer's `consent_accept` arrives while the consent
 * screen is up, is buffered by the MatchOrchestrator's queue, and is
 * picked up in phase 2.
 *
 * See 开发手册.md § 22–23, § 44, Phase 6, Phase 15, and docs/修复.md § 五 B2.
 */
import type { LLMProvider } from '@kindora/llm';
import {
  analyzeMatch,
  type AgentRuntimeConfig,
  type AnalyzeMatchInput,
  type AnalyzeMatchOptions,
  type AnalyzeMatchResult,
} from '@kindora/agent';
import type {
  AgentCapabilities,
  KsaHello,
  KsaMatchRequest,
  KsaMessage,
  KsaProfileExchange,
  MatchAnalysis,
  SocialAgent,
  SocialBoundaries,
  SocialProfile,
} from '@kindora/protocol';
import {
  assertProfileWithinBoundaries,
  buildPublicCard,
  createHello,
  createMatchRequest,
  createMatchResponse,
  createProfileExchange,
  filterProfileForOutbound,
  resolveBoundaries,
  type HelloPayload,
} from '@kindora/protocol';
import type { MessageHandler, PairingSession } from '@kindora/transport';
import { DEFAULT_PEER_CONSENT_TIMEOUT_MS, type ConsentState } from './consent-orchestrator';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Throw when the peer does not send a `hello` envelope in time. */
export class HandshakeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeTimeoutError';
  }
}

/** Throw when the peer's `hello` envelope is malformed (type, sender, payload). */
export class HandshakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeValidationError';
  }
}

/** Throw when the session is closed (by us or the peer) before the handshake completes. */
export class HandshakeClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandshakeClosedError';
  }
}

/**
 * Throw when the connected peer is on the local block list.
 *
 * Phase B: this is raised in phase 1 (`identify()`) — **before** any
 * profile data is sent. The old flow ran the guard *after* the profile
 * exchange, so a blocked peer still received the full profile; the
 * refusal only showed up in the UI.
 *
 * The `hello` envelope has necessarily been exchanged by the time the
 * peer's id is known (the id is what the block list is keyed by). The
 * hello carries the display name, the capability flags and the public
 * keys — **no profile fields at all** — so nothing the user gated is
 * disclosed to a blocked peer.
 */
export class PeerBlockedError extends Error {
  readonly peerAgentId: string;

  constructor(peerAgentId: string, reason?: string) {
    super(
      reason
        ? `Peer ${peerAgentId} is on the local block list: ${reason}`
        : `Peer ${peerAgentId} is on the local block list.`,
    );
    this.name = 'PeerBlockedError';
    this.peerAgentId = peerAgentId;
  }
}

/**
 * Throw when the authorised profile would be sent without a valid,
 * peer-specific, mutual human consent.
 *
 * Phase B: this is the enforcement point of task book § 五 B2
 * requirement 6 — 「未经过用户明确同意，不得发送完整资料」. The
 * orchestrator refuses to disclose rather than trusting the caller to
 * have shown the consent screen.
 */
export class ConsentRequiredError extends Error {
  /** Why the disclosure was refused. */
  readonly reason: 'no-local-consent' | 'peer-refused' | 'peer-timeout';

  constructor(reason: ConsentRequiredError['reason'], message: string) {
    super(message);
    this.name = 'ConsentRequiredError';
    this.reason = reason;
  }
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/**
 * The peer's public card — everything we know about them **before**
 * the human consent step.
 *
 * This is the only profile data that may cross the wire before the
 * user has agreed to talk to this peer.
 */
export interface PeerIntroduction {
  /** The peer's full agent id. */
  readonly peerAgentId: string;
  /** The peer's display name (from their `hello` or their card). */
  readonly peerDisplayName: string;
  /** The peer's public card, or null when the peer sent none. */
  readonly peerCard: SocialProfile | null;
  /** The peer's public agent view, or null when the peer sent none. */
  readonly peerAgent: SocialAgent | null;
}

/**
 * The proof that the local user agreed to this specific peer.
 *
 * Phase B: `exchangeAndMatch()` requires one of these. It is the
 * consent state machine's own outcome — the desktop passes the
 * `ConsentOutcome` it got from the `ConsentOrchestrator`, which
 * satisfies this shape structurally.
 *
 * Two independent facts are checked:
 *
 *   - `state === 'accepted_both'` — the local user accepted **and**
 *     the peer accepted. A consent that only covers one side is not
 *     enough to exchange profiles.
 *   - `peerAgentId` — the consent must be about **this** peer. A
 *     consent recorded for a different agent cannot be replayed here.
 */
export interface LocalConsent {
  /** The consent state machine's final state. */
  readonly state: ConsentState;
  /** The peer the consent was given to. */
  readonly peerAgentId: string;
  /** True iff both sides accepted. */
  readonly bothAccepted: boolean;
}

export interface MatchOrchestratorSelf {
  /** Local agent UUID — placed in `sender` on every outgoing envelope. */
  readonly agentId: string;
  /** Local display name — surfaced to the peer in `hello` and `match_response`. */
  readonly displayName: string;
  /** Local profile — filtered before it is shared (see `boundaries`). */
  readonly profile: SocialProfile;
  /** Local public agent view (without private key) — shared in `profile_exchange`. */
  readonly agent: SocialAgent;
  /** Local capabilities — sent in `hello`. */
  readonly capabilities: AgentCapabilities;
  /** LLM provider used to run the local `analyzeMatch` call. */
  readonly llm: LLMProvider;
  /** Agent-runtime config (token budget, etc.). */
  readonly config?: AgentRuntimeConfig;
  /** Optional LLM call overrides. */
  readonly llmOptions?: AnalyzeMatchOptions;
  /**
   * Optional guard called once the peer's id is known and **before any
   * profile data is sent**. Throw a `PeerBlockedError` to refuse the
   * peer; any other throw is propagated unchanged (it is a real
   * failure, not a block).
   */
  readonly peerGuard?: (peerAgentId: string) => void | Promise<void>;
  /**
   * The privacy boundaries in force **right now**.
   *
   * Phase B: this is a callback, not a snapshot, so that a
   * revocation the user makes mid-session takes effect on the next
   * message (task book § 五 B2 requirement 8: 「用户撤销授权后，应阻止
   * 后续相关数据传输」). Defaults to `self.profile.boundaries`.
   *
   * It may be async: the desktop reads the boundaries from the
   * persisted profile on every send, because that is the only copy
   * that reflects a revocation the user just made in another window
   * (or on another screen).
   */
  readonly boundaries?: () =>
    Partial<SocialBoundaries> | undefined | Promise<Partial<SocialBoundaries> | undefined>;
}

export interface MatchOutcome {
  /** The peer's display name (from their `hello` or their card). */
  readonly peerDisplayName: string;
  /** The peer's full agent id. */
  readonly peerAgentId: string;
  /**
   * The peer's public view (from their `profile_exchange`), with the
   * profile replaced by the **authorised** profile they sent in their
   * `match_request` (falling back to their public card).
   */
  readonly peerAgent: SocialAgent | null;
  /**
   * The peer's profile. After Phase B this is the **authorised**
   * profile from their `match_request` — the same copy that went into
   * the local analysis. It falls back to their public card when they
   * sent no `match_request`.
   */
  readonly peerProfile: SocialProfile | null;
  /** Local analysis (from `analyzeMatch`). Always present. */
  readonly localAnalysis: MatchAnalysis;
  /** The peer's analysis, if it arrived before the timeout. */
  readonly peerAnalysis: MatchAnalysis | null;
  /** Local LLM call metadata — handy for debug + tests. */
  readonly localResult: AnalyzeMatchResult;
  /** How long we waited for the peer's `match_response`. */
  readonly peerAnalysisTimeoutMs: number;
  /** True iff we gave up waiting for the peer's `match_response`. */
  readonly peerAnalysisTimedOut: boolean;
}

export interface MatchOrchestratorOptions {
  /** How long to wait for the peer's `match_response`. */
  readonly peerAnalysisTimeoutMs?: number;
  /** How long to wait for the peer's `profile_exchange` / `match_request`. */
  readonly earlyWaitTimeoutMs?: number;
  /** How long to wait for the peer's `hello` (hard gate). */
  readonly helloTimeoutMs?: number;
  /** Grace window for the peer's `hello` when the session is already connected. */
  readonly peerHelloGraceMs?: number;
  /** How long to wait for the peer's `consent_accept` in phase 2. */
  readonly peerConsentTimeoutMs?: number;
}

/** How long to wait for the peer's `match_response` before giving up. */
export const DEFAULT_PEER_ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the peer's `profile_exchange` / `match_request`
 * envelope before falling back to a minimal peer profile and continuing
 * with the local analysis. Those envelopes are informational, NOT a
 * handshake gate — a silent peer is treated as "no profile", not as a
 * hang.
 *
 * Note: this is NOT the hello timeout. The hello wait is a hard
 * gate governed by `DEFAULT_HELLO_TIMEOUT_MS` — see Phase 15.
 */
export const DEFAULT_EARLY_WAIT_TIMEOUT_MS = 2_000;

/**
 * How long to wait for the peer's `hello` envelope before failing the
 * handshake. This is a HARD gate: if the peer never sends a valid
 * `hello` within this window, the orchestrator closes the session
 * via `session.failHandshake()` and throws `HandshakeTimeoutError`.
 * The match analysis is NOT run.
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 5_000;

/**
 * How long the orchestrator waits for the peer's `hello` *envelope*
 * when the session already reports `connected`.
 *
 * In that state a prior consumer called `session.notifyHelloReceived`,
 * so the peer's id is already locked in and the envelope is only
 * needed for the peer's display name (and, on a signed session, the
 * identity key the transport layer verifies).
 *
 * We still give the envelope a window because it may be in flight — our
 * own hello send is asynchronous (Phase A / A3 derives an ephemeral key
 * before the envelope goes out), so the peer's hello can arrive *after*
 * we sent ours. But we must not wait the full `helloTimeoutMs`: an
 * external consumer may already have consumed the envelope, in which
 * case it will never arrive and we would stall the whole match for
 * five seconds. 250 ms is far longer than a loopback round trip and
 * short enough to be invisible in the UI.
 */
export const DEFAULT_PEER_HELLO_GRACE_MS = 250;

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

interface Waiter {
  readonly predicate: (m: KsaMessage) => boolean;
  readonly resolve: (value: KsaMessage | null) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

/**
 * True iff the message comes from a non-local sender that should be
 * treated as the peer. When `peerAgentId` is empty (e.g. the joiner
 * doesn't know the host's id yet), we accept any non-local sender
 * — the first such message teaches us the peer's id.
 */
function isFromPeer(msg: KsaMessage, peerAgentId: string, selfAgentId: string): boolean {
  if (peerAgentId) return msg.sender === peerAgentId;
  return msg.sender !== selfAgentId;
}

/**
 * Strict validation of a peer's `hello` envelope. Returns `{ ok: true }`
 * if the envelope is well-formed and not from the local agent; otherwise
 * `{ ok: false, error }` with a human-readable failure reason. The
 * orchestrator uses this to gate the rest of the flow on a genuine,
 * authenticated peer hello.
 */
function validatePeerHello(
  env: KsaMessage,
  selfAgentId: string,
): { ok: true } | { ok: false; error: string } {
  if (env.type !== 'hello') {
    return { ok: false, error: `expected message type "hello", got "${env.type}"` };
  }
  if (typeof env.sender !== 'string' || !env.sender) {
    return { ok: false, error: 'hello envelope has no sender field' };
  }
  if (env.sender === selfAgentId) {
    return { ok: false, error: 'hello sender equals self agentId (loopback / spoofed)' };
  }
  // Reject non-UUID senders — agent ids are UUIDs in KSA 0.1.
  const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_LIKE.test(env.sender)) {
    return {
      ok: false,
      error: `hello sender is not a UUID-shaped string (got ${JSON.stringify(env.sender)})`,
    };
  }
  const payload = env.payload as Partial<HelloPayload> | undefined;
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'hello payload is missing or not an object' };
  }
  if (typeof payload.displayName !== 'string' || !payload.displayName) {
    return { ok: false, error: 'hello payload.displayName is missing or empty' };
  }
  if (!payload.capabilities || typeof payload.capabilities !== 'object') {
    return { ok: false, error: 'hello payload.capabilities is missing or not an object' };
  }
  if (
    typeof payload.capabilities.protocolVersion !== 'string' ||
    !payload.capabilities.protocolVersion
  ) {
    return {
      ok: false,
      error: 'hello payload.capabilities.protocolVersion is missing or not an object',
    };
  }
  return { ok: true };
}

/**
 * A small in-process queue that wraps `PairingSession.onMessage` so
 * we can `await nextMatching(predicate)` deterministically.
 *
 * The queue is installed once per orchestrator and **survives across
 * the two phases** — that is what lets the peer's `consent_accept`
 * (which arrives while the consent screen is up) be picked up in
 * phase 2.
 */
class SessionQueue {
  private readonly queue: KsaMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private installed = false;

  install(session: PairingSession): void {
    if (this.installed) return;
    this.installed = true;
    const handler: MessageHandler = (msg) => this.push(msg);
    session.onMessage(handler);
    // Also install a state-change hook so waiters can be told the
    // session has closed.
    session.onStateChange((snap) => {
      if (snap.state === 'closed') {
        while (this.waiters.length > 0) {
          const w = this.waiters.shift();
          if (!w) break;
          w.resolve(null);
        }
      }
    });
  }

  push(msg: KsaMessage): void {
    // Try to satisfy an existing waiter first.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (!w) continue;
      if (w.predicate(msg)) {
        if (w.timer) clearTimeout(w.timer);
        w.done = true;
        this.waiters.splice(i, 1);
        w.resolve(msg);
        return;
      }
    }
    // Otherwise buffer for later.
    this.queue.push(msg);
  }

  /** Consume the next message matching `predicate`, with an optional timeout. */
  next<T extends KsaMessage>(
    predicate: (m: KsaMessage) => m is T,
    timeoutMs: number | null,
  ): Promise<T | null>;
  next(predicate: (m: KsaMessage) => boolean, timeoutMs: number | null): Promise<KsaMessage | null>;
  next(
    predicate: ((m: KsaMessage) => boolean) | ((m: KsaMessage) => m is KsaMessage),
    timeoutMs: number | null,
  ): Promise<KsaMessage | null> {
    const isMatch = predicate as (m: KsaMessage) => boolean;
    // Drain the buffer first.
    for (let i = 0; i < this.queue.length; i++) {
      const msg = this.queue[i];
      if (msg && isMatch(msg)) {
        this.queue.splice(i, 1);
        return Promise.resolve(msg);
      }
    }
    // Non-blocking drain: with timeoutMs === 0 (or negative), do not
    // register a waiter — the call site only wanted to drain the
    // currently-buffered messages.
    if (timeoutMs === null || timeoutMs <= 0) {
      return Promise.resolve(null);
    }
    return new Promise<KsaMessage | null>((resolve) => {
      const waiter: Waiter = {
        predicate: isMatch,
        resolve,
        timer: null,
        done: false,
      };
      waiter.timer = setTimeout(() => {
        if (waiter.done) return;
        waiter.done = true;
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

/* ------------------------------------------------------------------ */
/* The orchestrator                                                    */
/* ------------------------------------------------------------------ */

export class MatchOrchestrator {
  private readonly self: MatchOrchestratorSelf;
  /**
   * The peer's agent id. May be empty initially — the orchestrator
   * accepts any non-local sender and locks in the id from the first
   * received `hello` envelope. Once the id is known it is also locked
   * into the session via `session.notifyHelloReceived(peerAgentId)`.
   */
  private peerAgentId: string;
  private readonly peerAnalysisTimeoutMs: number;
  private readonly earlyWaitTimeoutMs: number;
  private readonly helloTimeoutMs: number;
  private readonly peerHelloGraceMs: number;
  private readonly peerConsentTimeoutMs: number;
  /** Installed once, in phase 1, and reused in phase 2. */
  private queue: SessionQueue | null = null;
  /** Reentrancy guards for the two phases. */
  private identified = false;
  private exchanged = false;
  /** What phase 1 learned about the peer. */
  private peerCard: SocialProfile | null = null;
  private peerAgent: SocialAgent | null = null;
  private peerDisplayName = '';

  constructor(
    self: MatchOrchestratorSelf,
    peerAgentId: string,
    options: MatchOrchestratorOptions = {},
  ) {
    this.self = self;
    this.peerAgentId = peerAgentId;
    this.peerAnalysisTimeoutMs = options.peerAnalysisTimeoutMs ?? DEFAULT_PEER_ANALYSIS_TIMEOUT_MS;
    this.earlyWaitTimeoutMs = options.earlyWaitTimeoutMs ?? DEFAULT_EARLY_WAIT_TIMEOUT_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.peerHelloGraceMs = options.peerHelloGraceMs ?? DEFAULT_PEER_HELLO_GRACE_MS;
    this.peerConsentTimeoutMs = options.peerConsentTimeoutMs ?? DEFAULT_PEER_CONSENT_TIMEOUT_MS;
  }

  /* ---------------------------------------------------------------- */
  /* Phase 1 — identify                                                */
  /* ---------------------------------------------------------------- */

  /**
   * Phase 1: say hello, refuse blocked peers, and exchange the
   * **minimal public card**.
   *
   * Nothing but the card may leave the device in this phase, and the
   * card carries only the fields the user authorised for the
   * pre-consent stage (nickname, social intent, conversation style).
   *
   * Accepts either `tcp-connected` (the orchestrator sends the local
   * `hello` and waits for the peer's) or `connected` (the peer's
   * `hello` was already validated by a previous step; the orchestrator
   * proceeds straight to the card).
   *
   * Throws:
   *   - `HandshakeTimeoutError`     if the peer's `hello` doesn't arrive in `helloTimeoutMs`
   *   - `HandshakeValidationError`  if the peer's `hello` is malformed
   *   - `HandshakeClosedError`      if the session is closed before handshake completes
   *   - `PeerBlockedError`          if the peer is on the local block list
   *
   * On a handshake failure the orchestrator calls
   * `session.failHandshake(reason)` and does NOT run `analyzeMatch` or
   * send any profile data.
   */
  async identify(session: PairingSession): Promise<PeerIntroduction> {
    if (this.exchanged) {
      throw new Error(
        'MatchOrchestrator.exchangeAndMatch has already run on this instance. ' +
          'Create a new MatchOrchestrator per pairing attempt.',
      );
    }
    if (this.identified) {
      throw new Error(
        'MatchOrchestrator.identify has already been called on this instance. ' +
          'Create a new MatchOrchestrator per pairing attempt.',
      );
    }
    this.identified = true;

    const initialState = session.current().state;
    if (initialState !== 'connected' && initialState !== 'tcp-connected') {
      throw new Error(
        `MatchOrchestrator.identify requires a tcp-connected or connected PairingSession (got "${initialState}").`,
      );
    }

    const queue = this.ensureQueue(session);

    // Yield twice so that a peer whose `identify()` was scheduled
    // concurrently can install its own queue handler before we send.
    // (LoopbackTransport delivers messages synchronously; without
    // this barrier, the first side to run sends before the other has
    // registered its receiver, and the message is lost. Real
    // transports like WebRTC deliver asynchronously, so this is a
    // pure dev-loopback safety net.)
    await Promise.resolve();
    await Promise.resolve();

    // 1) Send our own hello. This is allowed from `tcp-connected` —
    // the session is honest about the fact that the wire is up but
    // the peer's hello has not yet been validated.
    //
    // Phase A / A2 + A3: the hello carries our long-term identity
    // public key (so the peer can verify this message's signature) and
    // our ephemeral session key (so the peer can run ECDH with us).
    // Both are optional on the wire — a peer that predates them still
    // parses — but without them the session cannot be authenticated
    // or encrypted, and the peer says so through its capability flags.
    //
    // The hello carries NO profile fields — that is what makes it safe
    // to send before the block-list check has run.
    await session.send(
      createHello(this.self.agentId, {
        displayName: this.self.displayName,
        capabilities: this.self.capabilities,
        publicKey: this.self.agent.publicKey,
        sessionKeyExchange: (await session.sessionKeyExchange()) ?? undefined,
      }),
    );

    // 2) HARD GATE: wait for the peer's `hello`. If the session is
    //    already `connected` (a prior consumer validated the hello),
    //    we take the peer's id from the session and give the peer's
    //    hello envelope a short grace window. Otherwise we wait up to
    //    `helloTimeoutMs` and FAIL on timeout, invalid hello, or
    //    session close.
    let peerHello: KsaHello | null = null;
    const helloPredicate = (m: KsaMessage): m is KsaHello =>
      m.type === 'hello' && isFromPeer(m, this.peerAgentId, this.self.agentId);

    if (initialState === 'connected') {
      // The session says the hello was already validated — a prior
      // consumer called `session.notifyHelloReceived(peerAgentId)`.
      //
      // This used to be a *non-blocking* drain, and that was racy: our
      // own hello send is asynchronous (Phase A / A3 derives an
      // ephemeral key before the envelope goes out), so the peer's
      // hello could arrive *after* the drain — and a message that
      // arrives after the drain is never seen again. The peer id then
      // stayed empty, and every downstream consumer that filters by
      // sender (the chat and the consent orchestrators) dropped the
      // peer's messages silently, which looks exactly like a lost
      // connection.
      //
      // So we wait a short grace window instead. The envelope carries
      // the peer's display name; the peer id itself no longer depends
      // on it, because step 3 falls back to the id the session already
      // locked in.
      peerHello = await queue.next<KsaHello>(helloPredicate, this.peerHelloGraceMs);
    } else {
      // Hard gate.
      const candidate = await queue.next<KsaHello>(helloPredicate, this.helloTimeoutMs);
      if (!candidate) {
        // Either timeout or session closed. Distinguish BEFORE we
        // call failHandshake — once failHandshake runs, the session
        // is in 'closed' and we can no longer tell which case it
        // was. Phase 16.4: a `closeReason` of `'peer-closed'`
        // means the wire dropped mid-wait (the transport fired its
        // `onClose` event, which called `failHandshake('peer-
        // closed')` for us). Surface that as the more specific
        // `HandshakeClosedError` rather than the generic
        // `HandshakeTimeoutError` — the UI / caller can show "peer
        // disconnected" instead of "timed out".
        const wasClosedMidWait = session.current().state === 'closed';
        if (wasClosedMidWait && session.current().closeReason === 'peer-closed') {
          throw new HandshakeClosedError('Peer closed the connection before hello was received.');
        }
        if (!wasClosedMidWait) {
          await session.failHandshake('hello-timeout').catch(() => undefined);
        }
        if (wasClosedMidWait) {
          throw new HandshakeClosedError(
            `PairingSession closed before hello was received: ${session.current().closeReason ?? 'unknown'}`,
          );
        }
        throw new HandshakeTimeoutError(
          `Peer did not send a hello envelope within ${this.helloTimeoutMs}ms.`,
        );
      }
      const validation = validatePeerHello(candidate, this.self.agentId);
      if (!validation.ok) {
        await session.failHandshake(`hello-invalid: ${validation.error}`).catch(() => undefined);
        throw new HandshakeValidationError(`Peer's hello failed validation: ${validation.error}`);
      }
      peerHello = candidate;
    }

    // 3) Lock in the peer's id and transition the session to
    //    `connected` (if it wasn't already). This is the explicit
    //    handshake-complete signal that the rest of the flow keys on.
    if (peerHello) {
      this.peerAgentId = peerHello.sender;
      if (session.current().state === 'tcp-connected') {
        session.notifyHelloReceived(peerHello.sender);
      }
    } else if (!this.peerAgentId) {
      // We have no hello envelope to learn the peer's id from — but
      // the session may still know it: `notifyHelloReceived(peerAgentId)`
      // locks the id in, and 'connected' is only reachable through it.
      //
      // We must take it from here. An empty peer id makes every
      // downstream consumer that filters by sender (the chat and the
      // consent orchestrators) drop the peer's messages silently —
      // which looks exactly like a lost connection.
      this.peerAgentId = session.current().peerAgentId ?? '';
    }

    // 4) PHASE B: the block-list check runs HERE — before any profile
    //    data leaves the device. The old flow ran the guard after the
    //    profile exchange, so a blocked peer still received the full
    //    profile.
    //
    //    A blocked peer is disconnected on the spot: the peer must not
    //    be left waiting for a card that will never come.
    try {
      await this.assertPeerAllowed();
    } catch (err) {
      await session.disconnect('peer-blocked').catch(() => undefined);
      throw err;
    }

    // 5) Send the **public card** — not the full profile. The card is
    //    the minimal disclosure that lets the consent screen be a real
    //    decision.
    const boundaries = await this.currentBoundaries();
    const card = buildPublicCard(this.self.profile, boundaries);
    assertProfileWithinBoundaries(card, boundaries, 'profile_exchange.profile');
    await session.send(
      createProfileExchange(this.self.agentId, {
        profile: card,
        // The agent view carries the SAME card. Before Phase B this
        // was `this.self.agent`, whose `profile` was the full local
        // profile — the profile crossed the wire twice, once in the
        // clear and once nested.
        agent: { ...this.self.agent, profile: card },
      }),
    );

    // 6) Wait for the peer's `profile_exchange` (soft wait — this is
    //    NOT a handshake gate). A silent peer is treated as "no
    //    profile" and we proceed with a minimal fallback.
    const peerProfileExchange = await queue.next<KsaProfileExchange>(
      (m): m is KsaProfileExchange =>
        m.type === 'profile_exchange' && isFromPeer(m, this.peerAgentId, this.self.agentId),
      this.earlyWaitTimeoutMs,
    );

    this.peerCard = peerProfileExchange?.payload.profile ?? null;
    this.peerAgent = peerProfileExchange?.payload.agent ?? null;
    this.peerDisplayName =
      peerHello?.payload.displayName ??
      this.peerAgent?.displayName ??
      this.peerCard?.nickname ??
      this.peerAgentId.slice(0, 8);

    return {
      peerAgentId: this.peerAgentId,
      peerDisplayName: this.peerDisplayName,
      peerCard: this.peerCard,
      peerAgent: this.peerAgent,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Phase 2 — exchange the authorised profile and analyse             */
  /* ---------------------------------------------------------------- */

  /**
   * Phase 2: exchange the **authorised profile** and run the match
   * analysis.
   *
   * The order inside this method is the enforcement of task book
   * § 五 B2 requirement 6:
   *
   *   1. the local consent must be a mutual, peer-specific accept —
   *      otherwise `ConsentRequiredError` is thrown and **nothing is
   *      sent**;
   *   2. the peer's `consent_accept` must be on the wire — a peer
   *      that rejected or blocked ends the flow here;
   *   3. only then is the authorised profile built, asserted against
   *      the local boundaries, and sent in a `match_request`;
   *   4. the analysis runs on the **authorised** profiles only, so
   *      the `match_response` we ship cannot leak a field the user
   *      withheld.
   *
   * Throws `ConsentRequiredError` when the consent is missing,
   * peer-specifically wrong, refused by the peer, or never given.
   */
  async exchangeAndMatch(session: PairingSession, consent: LocalConsent): Promise<MatchOutcome> {
    if (!this.identified) {
      throw new Error(
        'MatchOrchestrator.exchangeAndMatch requires identify() to have run first — ' +
          'the public card must be exchanged before the consent step.',
      );
    }
    if (this.exchanged) {
      throw new Error(
        'MatchOrchestrator.exchangeAndMatch has already been called on this instance. ' +
          'Create a new MatchOrchestrator per pairing attempt.',
      );
    }
    this.exchanged = true;

    // 0) The block list is checked AGAIN here, not only in phase 1.
    //    Phase B / B3 requirement 7 (「对黑名单用户拒绝后续匹配请求」):
    //    a peer blocked while the consent screen was up must not get
    //    the authorised profile afterwards.
    try {
      await this.assertPeerAllowed();
    } catch (err) {
      await session.disconnect('peer-blocked').catch(() => undefined);
      throw err;
    }

    // 1) The local consent must be a mutual, peer-specific accept.
    if (!consent) {
      throw new ConsentRequiredError(
        'no-local-consent',
        'Refusing to send the authorised profile: no consent was recorded.',
      );
    }
    if (consent.state !== 'accepted_both' || consent.bothAccepted !== true) {
      throw new ConsentRequiredError(
        'no-local-consent',
        `Refusing to send the authorised profile: the consent state is "${consent.state}", not "accepted_both".`,
      );
    }
    if (!this.peerAgentId || consent.peerAgentId !== this.peerAgentId) {
      throw new ConsentRequiredError(
        'no-local-consent',
        `Refusing to send the authorised profile: the consent was given to "${consent.peerAgentId}", but the connected peer is "${this.peerAgentId}".`,
      );
    }

    const queue = this.ensureQueue(session);

    // 2) The peer must have accepted too — on the wire, not merely in
    //    the local state machine. The envelope may already be buffered
    //    (it typically arrives while the consent screen is up), in
    //    which case this returns immediately.
    const peerConsent = await queue.next(
      (m) =>
        isFromPeer(m, this.peerAgentId, this.self.agentId) &&
        (m.type === 'consent_accept' || m.type === 'consent_reject' || m.type === 'block'),
      this.peerConsentTimeoutMs,
    );
    if (!peerConsent) {
      throw new ConsentRequiredError(
        'peer-timeout',
        `Refusing to send the authorised profile: the peer did not answer the consent request within ${this.peerConsentTimeoutMs}ms.`,
      );
    }
    if (peerConsent.type !== 'consent_accept') {
      throw new ConsentRequiredError(
        'peer-refused',
        `Refusing to send the authorised profile: the peer sent "${peerConsent.type}".`,
      );
    }

    // 3) Build the authorised profile from the boundaries that are in
    //    force RIGHT NOW, and assert it before it goes on the wire.
    const boundaries = await this.currentBoundaries();
    const authorised = filterProfileForOutbound(this.self.profile, boundaries);
    assertProfileWithinBoundaries(authorised, boundaries, 'match_request.selfProfile');

    await session.send(createMatchRequest(this.self.agentId, { selfProfile: authorised }));

    // 4) Wait for the peer's authorised profile (soft wait).
    const peerMatchRequest = await queue.next<KsaMatchRequest>(
      (m): m is KsaMatchRequest =>
        m.type === 'match_request' && isFromPeer(m, this.peerAgentId, this.self.agentId),
      this.earlyWaitTimeoutMs,
    );

    const peerProfile =
      peerMatchRequest?.payload.selfProfile ??
      this.peerCard ??
      minimalProfile(this.peerDisplayName);
    const peerAgent = this.peerAgent ? { ...this.peerAgent, profile: peerProfile } : null;

    // 5) Run local analysis + wait for the peer's match_response
    //    concurrently. Per § 23, each side runs its OWN analysis; the
    //    peer's `match_response` is purely informational.
    //
    //    We start the peer's wait FIRST (cheap, registers a waiter),
    //    then run the LLM. As soon as the LLM returns, we ship our
    //    own `match_response` and then keep waiting for the peer —
    //    this breaks the symmetric-timeout deadlock where both sides
    //    time out before either has shipped its reply.
    //
    //    PHASE B: the analysis is computed from the **authorised**
    //    profiles — our own filtered copy, not the raw local profile.
    //    The `match_response` is peer-visible, so an analysis derived
    //    from a withheld field (say the bio) would leak exactly what
    //    the user gated.
    const analyzeInput: AnalyzeMatchInput = {
      selfProfile: authorised,
      selfDisplayName: this.self.displayName,
      peerProfile,
      peerDisplayName: this.peerDisplayName,
    };
    const analyzeConfig: AgentRuntimeConfig = this.self.config ?? {
      maxMatchTokens: 2000,
      maxAgentMessages: 6,
      maxIcebreakerTokens: 500,
      maxChatAssistTokens: 500,
    };

    let peerAnalysis: MatchAnalysis | null = null;
    let peerAnalysisTimedOut = false;
    const peerWaitPromise = queue
      .next(
        (m) => m.type === 'match_response' && isFromPeer(m, this.peerAgentId, this.self.agentId),
        this.peerAnalysisTimeoutMs,
      )
      .then((msg) => {
        if (msg && msg.type === 'match_response') {
          peerAnalysis = msg.payload.analysis;
        } else {
          peerAnalysisTimedOut = true;
        }
      })
      .catch(() => {
        peerAnalysisTimedOut = true;
      });

    const localResult = await analyzeMatch(
      this.self.llm,
      analyzeInput,
      analyzeConfig,
      this.self.llmOptions ?? {},
    );

    // 6) Ship our analysis immediately so the peer can stop waiting.
    await session.send(
      createMatchResponse(this.self.agentId, {
        analysis: localResult.analysis,
        displayName: this.self.displayName,
      }),
    );

    // 7) Now wait for the peer (bounded). If they never respond we
    //    still return our local result — the user can decide to
    //    accept/reject/block on local signal alone.
    await peerWaitPromise;

    return {
      peerDisplayName: this.peerDisplayName,
      peerAgentId: this.peerAgentId,
      peerAgent,
      peerProfile,
      localAnalysis: localResult.analysis,
      peerAnalysis,
      localResult,
      peerAnalysisTimeoutMs: this.peerAnalysisTimeoutMs,
      peerAnalysisTimedOut,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  private ensureQueue(session: PairingSession): SessionQueue {
    if (!this.queue) {
      this.queue = new SessionQueue();
      this.queue.install(session);
    }
    return this.queue;
  }

  /**
   * The boundaries in force right now.
   *
   * Read through the `boundaries` callback when one is supplied so a
   * mid-session revocation takes effect on the next send; otherwise
   * fall back to the profile's own boundaries.
   */
  private async currentBoundaries(): Promise<Partial<SocialBoundaries>> {
    const live = await this.self.boundaries?.();
    if (live) return live;
    return this.self.profile.boundaries;
  }

  /**
   * Phase B: refuse a blocked peer **before** any profile is sent.
   *
   * The guard is injected by the caller (the desktop wires it to the
   * block-list store). A `PeerBlockedError` from the guard means
   * "blocked" and is re-thrown as-is; any other error is a genuine
   * failure and is propagated unchanged.
   */
  private async assertPeerAllowed(): Promise<void> {
    if (!this.self.peerGuard) return;
    // A `PeerBlockedError` from the guard means "blocked" and travels
    // out unchanged; any other error is a genuine failure (a store
    // that could not be read, say) and is propagated as-is too — we
    // must not silently treat "we could not check" as "allowed".
    await this.self.peerGuard(this.peerAgentId);
  }
}

/**
 * Fallback profile when the peer's profile never arrived.
 *
 * Phase B: the boundaries use the protocol defaults rather than the
 * pre-Phase-B literal, so a silent peer is treated exactly like a peer
 * that sent the conservative default card.
 */
function minimalProfile(displayName: string): SocialProfile {
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
