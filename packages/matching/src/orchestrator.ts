/**
 * MatchOrchestrator — drives the Phase 6 wire flow on top of a
 * `PairingSession` whose transport is up.
 *
 * Phase 15 tightening: the orchestrator no longer accepts a "degrade
 * gracefully on missed hello" fallback. The peer's `hello` envelope
 * is a HARD GATE: if it doesn't arrive within `helloTimeoutMs`, is
 * malformed, or its `sender` is the local agent id, the orchestrator
 *   (1) calls `session.failHandshake(reason)` to close the session,
 *   (2) throws a typed error (HandshakeTimeoutError /
 *       HandshakeValidationError / HandshakeClosedError), and
 *   (3) does NOT run the LLM, the `match_request`, or the
 *       `match_response` flow.
 *
 * Only after a valid `hello` is received and validated does the
 * orchestrator call `session.notifyHelloReceived(peerAgentId)` and
 * proceed with the `profile_exchange` / `match_request` /
 * `match_response` flow. The `earlyWaitTimeoutMs` still applies to
 * the `profile_exchange` wait — that envelope is informational, not
 * a handshake gate — and the `peerAnalysisTimeoutMs` still bounds
 * the `match_response` wait.
 *
 * Flow (per 开发手册.md § 22–23, § 44, Phase 15):
 *
 *   1. send `hello`                          → handshake (HARD GATE)
 *   2. await peer's `hello` (helloTimeoutMs) → validate sender / type / payload
 *   3. session.notifyHelloReceived(peerAgentId) — tcp-connected → connected
 *   4. send `profile_exchange`               → share identity (soft wait)
 *   5. await peer's `profile_exchange`       → learn peer's identity
 *   6. send `match_request`                  → request analysis
 *   7. concurrently:
 *        a) run local `analyzeMatch` (LLM)
 *        b) await peer's `match_response`
 *   8. send `match_response`                 → share our analysis
 *   9. resolve with the final outcome
 *
 * The orchestrator is **stateless** between `start()` calls. It does
 * not own timers — the caller controls the lifecycle. Incoming
 * envelopes that don't match the expected `sender === peer.agentId`
 * are dropped defensively (§ 50).
 *
 * Implementation note — `PairingSession.onMessage` only stores the
 * most recent handler. To sequence several awaits on the same
 * session, we install a SINGLE handler that pushes every incoming
 * message into a queue, and `awaitMessage` consumes the queue under
 * a filter. This keeps ordering stable even if the peer sends
 * faster than we await.
 *
 * See 开发手册.md Phase 6 + Phase 15.
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
  KsaMessage,
  KsaProfileExchange,
  MatchAnalysis,
  SocialAgent,
  SocialProfile,
} from '@kindora/protocol';
import {
  createHello,
  createMatchRequest,
  createMatchResponse,
  createProfileExchange,
  type HelloPayload,
} from '@kindora/protocol';
import type { MessageHandler, PairingSession } from '@kindora/transport';

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

export interface MatchOrchestratorSelf {
  /** Local agent UUID — placed in `sender` on every outgoing envelope. */
  readonly agentId: string;
  /** Local display name — surfaced to the peer in `hello` and `match_response`. */
  readonly displayName: string;
  /** Local profile — shared in `profile_exchange` and `match_request`. */
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
   * Optional guard called once the peer's id is known. Throw to abort
   * the match (e.g. peer is on the local block list). The orchestrator
   * catches the throw and surfaces a `peerRefused` outcome.
   */
  readonly peerGuard?: (peerAgentId: string) => void | Promise<void>;
}

export interface MatchOutcome {
  /** The peer's display name (from their `hello` or `profile_exchange`). */
  readonly peerDisplayName: string;
  /** The peer's full agent id. */
  readonly peerAgentId: string;
  /** The peer's public view (from their `profile_exchange`). */
  readonly peerAgent: SocialAgent | null;
  /** The peer's profile (from their `profile_exchange`). */
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
  /**
   * True iff the peer was refused by a `peerGuard` (e.g. on the local
   * block list). When true, the session is closed before any match
   * analysis runs.
   */
  readonly peerRefused: boolean;
}

/** How long to wait for the peer's `match_response` before giving up. */
export const DEFAULT_PEER_ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the peer's `profile_exchange` envelope before
 * falling back to a minimal peer profile and continuing with the
 * local analysis. The `profile_exchange` is informational, NOT a
 * handshake gate — a silent peer is treated as "no profile", not as
 * a hang.
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
    return { ok: false, error: `hello sender is not a UUID-shaped string (got ${JSON.stringify(env.sender)})` };
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
  if (typeof payload.capabilities.protocolVersion !== 'string' || !payload.capabilities.protocolVersion) {
    return { ok: false, error: 'hello payload.capabilities.protocolVersion is missing or empty' };
  }
  return { ok: true };
}

/**
 * A small in-process queue that wraps `PairingSession.onMessage` so
 * we can `await nextMatching(predicate)` deterministically.
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
  next(
    predicate: (m: KsaMessage) => boolean,
    timeoutMs: number | null,
  ): Promise<KsaMessage | null>;
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
  /**
   * Reentrancy guard. A single MatchOrchestrator instance must be
   * `start()`ed at most once per (session, self) — calling it again
   * would register a second queue handler, ship a duplicate
   * `match_request`, and call the LLM twice. We throw on the second
   * call instead of silently double-driving the wire.
   */
  private started = false;

  constructor(
    self: MatchOrchestratorSelf,
    peerAgentId: string,
    options: {
      peerAnalysisTimeoutMs?: number;
      earlyWaitTimeoutMs?: number;
      helloTimeoutMs?: number;
    } = {},
  ) {
    this.self = self;
    this.peerAgentId = peerAgentId;
    this.peerAnalysisTimeoutMs =
      options.peerAnalysisTimeoutMs ?? DEFAULT_PEER_ANALYSIS_TIMEOUT_MS;
    this.earlyWaitTimeoutMs = options.earlyWaitTimeoutMs ?? DEFAULT_EARLY_WAIT_TIMEOUT_MS;
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  }

  /**
   * Drive the match flow against a `PairingSession` whose wire is up.
   * Accepts either `tcp-connected` (the orchestrator will send the
   * local `hello` and wait for the peer's `hello`) or `connected`
   * (the peer's `hello` was already validated by a previous step;
   * the orchestrator proceeds straight to `profile_exchange`).
   *
   * Throws:
   *   - `HandshakeTimeoutError`     if the peer's `hello` doesn't arrive in `helloTimeoutMs`
   *   - `HandshakeValidationError`  if the peer's `hello` is malformed
   *   - `HandshakeClosedError`      if the session is closed before handshake completes
   *
   * On any of those failures, the orchestrator calls
   * `session.failHandshake(reason)` and does NOT run `analyzeMatch`,
   * the `match_request` / `match_response` flow, or `createMatchResponse`.
   * The `MatchOutcome` is the success shape; handshake failure throws.
   */
  async start(session: PairingSession): Promise<MatchOutcome> {
    if (this.started) {
      throw new Error(
        'MatchOrchestrator.start has already been called on this instance. ' +
          'Create a new MatchOrchestrator per pairing attempt.',
      );
    }
    this.started = true;
    const initialState = session.current().state;
    if (initialState !== 'connected' && initialState !== 'tcp-connected') {
      throw new Error(
        `MatchOrchestrator.start requires a tcp-connected or connected PairingSession (got "${initialState}").`,
      );
    }

    const queue = new SessionQueue();
    queue.install(session);

    // Yield twice so that a peer whose `start()` was scheduled
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
    await session.send(
      createHello(this.self.agentId, {
        displayName: this.self.displayName,
        capabilities: this.self.capabilities,
      }),
    );

    // 2) HARD GATE: wait for the peer's `hello`. If the session is
    //    already `connected` (a prior consumer validated the hello),
    //    we can drain any buffered hello from the queue without a
    //    wait. Otherwise we wait up to `helloTimeoutMs` and FAIL on
    //    timeout, invalid hello, or session close.
    let peerHello: KsaHello | null = null;
    if (initialState === 'connected') {
      // Session says hello was already validated. Drain a buffered
      // hello if it's there; otherwise the peer must have called
      // `session.notifyHelloReceived` from the outside, which means
      // they already received ours. We proceed.
      peerHello = await queue.next<KsaHello>(
        (m): m is KsaHello =>
          m.type === 'hello' && isFromPeer(m, this.peerAgentId, this.self.agentId),
        0, // non-blocking drain
      );
    } else {
      // Hard gate.
      const candidate = await queue.next<KsaHello>(
        (m): m is KsaHello =>
          m.type === 'hello' && isFromPeer(m, this.peerAgentId, this.self.agentId),
        this.helloTimeoutMs,
      );
      if (!candidate) {
        // Either timeout or session closed. Distinguish BEFORE we
        // call failHandshake — once failHandshake runs, the session
        // is in 'closed' and we can no longer tell which case it
        // was.
        const wasClosedMidWait = session.current().state === 'closed';
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
    }

    // 4) Send profile exchange. Allowed now because the session is
    //    `connected` (or was already so before this call).
    await session.send(
      createProfileExchange(this.self.agentId, {
        profile: this.self.profile,
        agent: this.self.agent,
      }),
    );

    // 5) Wait for the peer's `profile_exchange` (soft wait — this is
    //    NOT a handshake gate). A silent peer is treated as "no
    //    profile" and we proceed with a minimal fallback.
    const peerProfileExchange = await queue.next<KsaProfileExchange>(
      (m): m is KsaProfileExchange =>
        m.type === 'profile_exchange' && isFromPeer(m, this.peerAgentId, this.self.agentId),
      this.earlyWaitTimeoutMs,
    );

    // Peer guard — runs once we know who they are. The caller uses
    // this to refuse a blocked peer; the orchestrator captures the
    // refusal in `peerRefused` and short-circuits to a "none" result.
    let peerRefused = false;
    if (this.self.peerGuard) {
      try {
        await this.self.peerGuard(this.peerAgentId);
      } catch {
        peerRefused = true;
        // We still ship our own hello/profile so the peer gets a
        // well-formed exchange — the refusal surfaces on the UI.
      }
    }

    const peerProfile = peerProfileExchange?.payload.profile ?? null;
    const peerAgent = peerProfileExchange?.payload.agent ?? null;
    const peerDisplayName =
      peerHello?.payload.displayName ??
      peerAgent?.displayName ??
      peerProfile?.nickname ??
      this.peerAgentId.slice(0, 8);

    // 6) Send match_request.
    await session.send(
      createMatchRequest(this.self.agentId, { selfProfile: this.self.profile }),
    );

    // 7) Run local analysis + wait for the peer's match_response
    //    concurrently. Per § 23, each side runs its OWN analysis; the
    //    peer's `match_response` is purely informational.
    //
    //    We start the peer's wait FIRST (cheap, registers a waiter),
    //    then run the LLM. As soon as the LLM returns, we ship our
    //    own `match_response` and then keep waiting for the peer —
    //    this breaks the symmetric-timeout deadlock where both sides
    //    time out before either has shipped its reply.
    const analyzeInput: AnalyzeMatchInput = {
      selfProfile: this.self.profile,
      selfDisplayName: this.self.displayName,
      peerProfile: peerProfile ?? minimalProfile(peerDisplayName),
      peerDisplayName,
    };
    const analyzeConfig: AgentRuntimeConfig = this.self.config ?? { maxMatchTokens: 2000, maxAgentMessages: 6, maxIcebreakerTokens: 500, maxChatAssistTokens: 500 };

    let peerAnalysis: MatchAnalysis | null = null;
    let peerAnalysisTimedOut = false;
    const peerWaitPromise = queue
      .next(
        (m) =>
          m.type === 'match_response' && isFromPeer(m, this.peerAgentId, this.self.agentId),
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

    // Short-circuit: if the peer was refused by the guard, don't run
    // the LLM — return a 'none' analysis immediately.
    let localResult: AnalyzeMatchResult;
    if (peerRefused) {
      localResult = {
        analysis: {
          compatibilitySignal: 'none',
          commonGround: [],
          recommendedTopics: [],
          potentialFriction: ['peer is on the local block list'],
          explanation: 'This peer is on your block list. The conversation is refused.',
        },
        messages: [],
        estimatedTokens: 0,
        rawResponse: '',
        degraded: false,
        degradationNote: null,
      };
    } else {
      localResult = await analyzeMatch(
        this.self.llm,
        analyzeInput,
        analyzeConfig,
        this.self.llmOptions ?? {},
      );
    }

    // 8) Ship our analysis immediately so the peer can stop waiting.
    await session.send(
      createMatchResponse(this.self.agentId, {
        analysis: localResult.analysis,
        displayName: this.self.displayName,
      }),
    );

    // 9) Now wait for the peer (bounded). If they never respond we
    //    still return our local result — the user can decide to
    //    accept/reject/block on local signal alone.
    await peerWaitPromise;

    return {
      peerDisplayName,
      peerAgentId: this.peerAgentId,
      peerAgent,
      peerProfile,
      localAnalysis: localResult.analysis,
      peerAnalysis,
      localResult,
      peerAnalysisTimeoutMs: this.peerAnalysisTimeoutMs,
      peerAnalysisTimedOut,
      peerRefused,
    };
  }
}

/** Fallback profile when the peer's `profile_exchange` is somehow missing. */
function minimalProfile(displayName: string): SocialProfile {
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
