/**
 * MatchOrchestrator — drives the Phase 6 wire flow on top of an
 * already-connected `PairingSession`.
 *
 * Flow (per 开发手册.md § 22–23, § 44):
 *
 *   1. send `hello`                          → handshake
 *   2. send `profile_exchange`               → share identity
 *   3. await peer's `profile_exchange`       → learn peer's identity
 *   4. send `match_request`                  → request analysis
 *   5. concurrently:
 *        a) run local `analyzeMatch` (LLM)
 *        b) await peer's `match_response`
 *   6. send `match_response`                 → share our analysis
 *   7. resolve with the final outcome
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
 * See 开发手册.md Phase 6.
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
} from '@kindora/protocol';
import type { MessageHandler, PairingSession } from '@kindora/transport';

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
}

/** How long to wait for the peer's `match_response` before giving up. */
export const DEFAULT_PEER_ANALYSIS_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the peer's `hello` and `profile_exchange`
 * envelopes before falling back to a minimal peer profile and
 * continuing with the local analysis. Short by design — a silent
 * peer is treated as "no profile", not as a hang.
 */
export const DEFAULT_EARLY_WAIT_TIMEOUT_MS = 2_000;

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
    return new Promise<KsaMessage | null>((resolve) => {
      const waiter: Waiter = {
        predicate: isMatch,
        resolve,
        timer: null,
        done: false,
      };
      if (timeoutMs !== null && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }
}

export class MatchOrchestrator {
  private readonly self: MatchOrchestratorSelf;
  /**
   * The peer's agent id. May be empty initially — the orchestrator
   * accepts any non-local sender and locks in the id from the first
   * received message.
   */
  private peerAgentId: string;
  private readonly peerAnalysisTimeoutMs: number;
  private readonly earlyWaitTimeoutMs: number;

  constructor(
    self: MatchOrchestratorSelf,
    peerAgentId: string,
    options: { peerAnalysisTimeoutMs?: number; earlyWaitTimeoutMs?: number } = {},
  ) {
    this.self = self;
    this.peerAgentId = peerAgentId;
    this.peerAnalysisTimeoutMs =
      options.peerAnalysisTimeoutMs ?? DEFAULT_PEER_ANALYSIS_TIMEOUT_MS;
    this.earlyWaitTimeoutMs = options.earlyWaitTimeoutMs ?? DEFAULT_EARLY_WAIT_TIMEOUT_MS;
  }

  /**
   * Drive the match flow against a connected `PairingSession`. Resolves
   * with the local + peer analysis once both are available, or with
   * `peerAnalysis === null` and `peerAnalysisTimedOut === true` if the
   * peer doesn't respond in time.
   */
  async start(session: PairingSession): Promise<MatchOutcome> {
    if (session.current().state !== 'connected') {
      throw new Error(
        `MatchOrchestrator.start requires a connected PairingSession (got "${session.current().state}").`,
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

    // 1) Send hello.
    await session.send(
      createHello(this.self.agentId, {
        displayName: this.self.displayName,
        capabilities: this.self.capabilities,
      }),
    );

    // 2) Send profile exchange.
    await session.send(
      createProfileExchange(this.self.agentId, {
        profile: this.self.profile,
        agent: this.self.agent,
      }),
    );

    // 3) Wait for peer's hello + profile_exchange. Both waits have a
    //    short timeout: a peer that doesn't speak at all is treated
    //    as "no profile", and the orchestrator proceeds with a
    //    minimal fallback so the human can still see the local
    //    analysis and decide to disconnect (§ 7).
    const peerHello = await queue.next<KsaHello>(
      (m): m is KsaHello =>
        m.type === 'hello' && isFromPeer(m, this.peerAgentId, this.self.agentId),
      this.earlyWaitTimeoutMs,
    );
    const peerProfileExchange = await queue.next<KsaProfileExchange>(
      (m): m is KsaProfileExchange =>
        m.type === 'profile_exchange' && isFromPeer(m, this.peerAgentId, this.self.agentId),
      this.earlyWaitTimeoutMs,
    );

    // Lock in the peer's id from the first received message so the
    // rest of the flow has a consistent identity to use.
    const discoveredPeerId =
      peerHello?.sender ?? peerProfileExchange?.sender ?? this.peerAgentId;
    if (!this.peerAgentId && discoveredPeerId) {
      this.peerAgentId = discoveredPeerId;
    }

    const peerProfile = peerProfileExchange?.payload.profile ?? null;
    const peerAgent = peerProfileExchange?.payload.agent ?? null;
    const peerDisplayName =
      peerHello?.payload.displayName ??
      peerAgent?.displayName ??
      peerProfile?.nickname ??
      this.peerAgentId.slice(0, 8);

    // 4) Send match_request.
    await session.send(
      createMatchRequest(this.self.agentId, { selfProfile: this.self.profile }),
    );

    // 5) Run local analysis + wait for the peer's match_response
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
    const analyzeConfig: AgentRuntimeConfig = this.self.config ?? { maxMatchTokens: 2000, maxAgentMessages: 6, maxIcebreakerTokens: 500 };

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
      peerDisplayName,
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
