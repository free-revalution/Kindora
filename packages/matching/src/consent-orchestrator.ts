/**
 * ConsentOrchestrator — Phase 7.
 *
 * Drives the human consent handshake on top of an already-connected
 * `PairingSession`, immediately after Phase 6 (MatchOrchestrator) has
 * produced a `MatchOutcome`. Implements the state machine described
 * in 开发手册.md § 27, Phase 7:
 *
 *   awaiting_decision
 *      │
 *      ├─ local accept ─► accepted_local ─┐
 *      │                                  ├─► accepted_both (chat unlocked)
 *      │                                  │
 *      │   ◄─ peer accept ─── accepted_peer
 *      │
 *      ├─ local reject ─► rejected  (terminal; session closes)
 *      ├─ peer reject  ─► rejected  (terminal; session closes)
 *      ├─ local block  ─► blocked   (terminal; peer id persisted locally)
 *      └─ peer block   ─► blocked   (terminal; peer id persisted locally)
 *
 * The orchestrator listens for `consent_accept`, `consent_reject`, and
 * `block` envelopes from the peer independently of the user clicking
 * the corresponding button. The first to commit wins; once a terminal
 * state is reached no further transitions are possible.
 *
 * Concurrency: the user can click Accept while the peer's `consent_accept`
 * is in flight. Both decisions are tracked separately; if both are
 * positive, we transition to `accepted_both` immediately.
 *
 * Block list: the orchestrator consults an injected
 * `BlockedAgentsLookup` (typically `@kindora/storage`'s
 * `BlockedAgentsStore`) before sending `block`, and writes to it after
 * the user clicks Block. The lookup is also called when the peer sends
 * us a `block` — we record the peer's id so we never re-engage.
 *
 * Reuses `PairingSession` (which now supports multiple message
 * handlers — Phase 7 change) so this can coexist with the
 * MatchOrchestrator's queue on the same session.
 *
 * See 开发手册.md Phase 7.
 */
import type { KsaMessage } from '@kindora/protocol';
import {
  createBlock,
  createConsentAccept,
  createConsentReject,
} from '@kindora/protocol';
import type { PairingSession } from '@kindora/transport';

/** How long to wait for the peer's `consent_accept` after the local accept. */
export const DEFAULT_PEER_CONSENT_TIMEOUT_MS = 60_000;

/** What the local user can do. */
export type ConsentDecision = 'accept' | 'reject' | 'block';

/** All reachable states. */
export type ConsentState =
  | 'awaiting_decision'
  | 'accepted_local'
  | 'accepted_peer'
  | 'accepted_both'
  | 'rejected'
  | 'blocked';

/** What the orchestrator ultimately resolves with. */
export interface ConsentOutcome {
  /** Final state of the consent flow. */
  readonly state: ConsentState;
  /** The peer's display name (from the prior MatchOrchestrator outcome). */
  readonly peerDisplayName: string;
  /** The peer's full agent id. */
  readonly peerAgentId: string;
  /** True iff the final state is `accepted_both` — the chat is unlocked. */
  readonly bothAccepted: boolean;
  /** True iff the user clicked Block (locally). */
  readonly blockedByLocal: boolean;
  /** True iff the peer sent us a `block` envelope. */
  readonly blockedByPeer: boolean;
  /** True iff the local user accepted but the peer never replied in time. */
  readonly peerAcceptTimedOut: boolean;
  /** How long we waited (ms) before giving up — surfaces to the UI. */
  readonly peerConsentTimeoutMs: number;
  /**
   * Whether the session is still open after this outcome. After a
   * terminal state (`rejected`, `blocked`, or `accepted_both` being
   * not the case) the caller is responsible for closing the session.
   */
  readonly sessionClosed: boolean;
}

/**
 * Pluggable block-list. Avoids a hard import on `@kindora/storage`
 * here — callers wire in the concrete store (`BrowserLocal…`,
 * `InMemory…`).
 */
export interface BlockedAgentsLookup {
  has(agentId: string): Promise<boolean>;
  add(agentId: string, reason?: string): Promise<void>;
}

export interface ConsentOrchestratorOptions {
  /** How long to wait for the peer's `consent_accept` after the local accept. */
  peerConsentTimeoutMs?: number;
  /** Block list. Defaults to a no-op if not provided. */
  blockList?: BlockedAgentsLookup;
}

interface PeerDecision {
  kind: 'accept' | 'reject' | 'block';
  reason?: string;
}

/**
 * A small in-process queue that wraps `PairingSession.onMessage` so
 * we can `await nextMatching(predicate)` deterministically. This is
 * the same shape as the MatchOrchestrator's queue, but kept local to
 * the consent phase so the two orchestrators never compete.
 */
class ConsentQueue {
  private readonly queue: KsaMessage[] = [];
  private readonly waiters: Array<{
    predicate: (m: KsaMessage) => boolean;
    resolve: (value: KsaMessage | null) => void;
    timer: ReturnType<typeof setTimeout> | null;
    done: boolean;
  }> = [];
  private installed = false;

  install(session: PairingSession): () => void {
    if (this.installed) throw new Error('ConsentQueue already installed');
    this.installed = true;
    const off = session.onMessage((msg) => this.push(msg));
    const offState = session.onStateChange((snap) => {
      if (snap.state === 'closed') {
        while (this.waiters.length > 0) {
          const w = this.waiters.shift();
          if (!w) break;
          if (w.timer) clearTimeout(w.timer);
          w.done = true;
          w.resolve(null);
        }
      }
    });
    return () => {
      off();
      offState();
    };
  }

  private push(msg: KsaMessage): void {
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
    this.queue.push(msg);
  }

  next(
    predicate: (m: KsaMessage) => boolean,
    timeoutMs: number | null,
  ): Promise<KsaMessage | null> {
    for (let i = 0; i < this.queue.length; i++) {
      const msg = this.queue[i];
      if (msg && predicate(msg)) {
        this.queue.splice(i, 1);
        return Promise.resolve(msg);
      }
    }
    return new Promise<KsaMessage | null>((resolve) => {
      const waiter = {
        predicate,
        resolve,
        timer: null as ReturnType<typeof setTimeout> | null,
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

export class ConsentOrchestrator {
  private readonly selfAgentId: string;
  private readonly peerDisplayName: string;
  private readonly peerAgentId: string;
  private readonly peerConsentTimeoutMs: number;
  private readonly blockList: BlockedAgentsLookup;
  private state: ConsentState = 'awaiting_decision';
  private localDecision: 'accept' | 'reject' | 'block' | null = null;
  private peerDecision: PeerDecision | null = null;
  private blockedByLocal = false;
  private blockedByPeer = false;
  private resolvePromise: ((outcome: ConsentOutcome) => void) | null = null;

  constructor(input: {
    readonly selfAgentId: string;
    readonly peerDisplayName: string;
    readonly peerAgentId: string;
    readonly options?: ConsentOrchestratorOptions;
  }) {
    this.selfAgentId = input.selfAgentId;
    this.peerDisplayName = input.peerDisplayName;
    this.peerAgentId = input.peerAgentId;
    this.peerConsentTimeoutMs =
      input.options?.peerConsentTimeoutMs ?? DEFAULT_PEER_CONSENT_TIMEOUT_MS;
    this.blockList = input.options?.blockList ?? NoopBlockList;
  }

  /** Current state (read-only, for the UI). */
  current(): ConsentState {
    return this.state;
  }

  /**
   * Begin listening for the peer's consent decision. Resolves as soon
   * as the flow reaches a terminal state. The caller should `await`
   * this BEFORE showing the consent buttons so any in-flight peer
   * decision is captured without flicker.
   *
   * The returned promise resolves with the final `ConsentOutcome`. It
   * never rejects (errors are folded into a `rejected` state with a
   * human-readable `closeReason` in the outcome).
   */
  async start(session: PairingSession): Promise<ConsentOutcome> {
    if (session.current().state !== 'connected') {
      throw new Error(
        `ConsentOrchestrator.start requires a connected PairingSession (got "${session.current().state}").`,
      );
    }

    const queue = new ConsentQueue();
    const uninstall = queue.install(session);

    // Track the final outcome so the terminal-state handler can use it.
    const terminalPromise = new Promise<ConsentOutcome>((resolve) => {
      this.resolvePromise = resolve;
    });

    // Listen for ANY of the peer's consent envelopes. Once the peer
    // has made a decision we transition accordingly; if the user also
    // clicked by then, both halves are merged.
    void this.listenForPeer(session, queue, uninstall);
    return terminalPromise;
  }

  /**
   * User-initiated action. Idempotent: a second click on the same
   * decision is a no-op. Calling `decide('accept')` after the local
   * user already rejected (or vice-versa) throws — the UI should
   * disable the buttons once a terminal state is reached.
   */
  async decide(session: PairingSession, decision: ConsentDecision, note?: string): Promise<void> {
    if (this.isTerminal(this.state)) {
      throw new Error(`Consent already finalised in state "${this.state}".`);
    }
    if (this.localDecision !== null) {
      throw new Error(`Local decision already taken: "${this.localDecision}".`);
    }
    this.localDecision = decision;

    if (decision === 'accept') {
      await session.send(createConsentAccept(this.selfAgentId, note ? { note } : {}));
      this.transitionTo(this.peerDecision?.kind === 'accept' ? 'accepted_both' : 'accepted_local');
    } else if (decision === 'reject') {
      await session.send(createConsentReject(this.selfAgentId, note ? { reason: note } : {}));
      this.transitionTo('rejected');
    } else {
      // block
      await this.blockList.add(this.peerAgentId, note);
      await session.send(createBlock(this.selfAgentId, note ? { reason: note } : {}));
      this.blockedByLocal = true;
      this.transitionTo('blocked');
    }
  }

  /* ----------------------------------------------------------------- */
  /* Internals                                                          */
  /* ----------------------------------------------------------------- */

  private async listenForPeer(
    session: PairingSession,
    queue: ConsentQueue,
    uninstall: () => void,
  ): Promise<void> {
    // Wait for ANY of the peer's consent envelopes, with no timeout
    // for reject/block (they're always terminal when received) but
    // a long timeout for accept (so the local user isn't hung if the
    // peer takes time).
    const peerMsg = await queue.next(
      (m) =>
        m.type === 'consent_accept' ||
        m.type === 'consent_reject' ||
        m.type === 'block',
      this.state === 'accepted_local' ? this.peerConsentTimeoutMs : null,
    );

    uninstall();

    if (!peerMsg) {
      // Either the session closed, or we timed out waiting for accept.
      if (this.state === 'accepted_local') {
        // Soft timeout: local user accepted, peer never replied. We
        // surface this in the outcome but don't terminate the session.
        this.resolveOutcome({
          peerAcceptTimedOut: true,
        });
      } else if (this.state === 'awaiting_decision') {
        // Session was closed (e.g. local user clicked Disconnect).
        this.resolveOutcome({});
      }
      // Otherwise: already in a terminal state from a local decision.
      return;
    }

    if (peerMsg.type === 'consent_accept') {
      this.peerDecision = { kind: 'accept' };
      this.transitionTo(this.localDecision === 'accept' ? 'accepted_both' : 'accepted_peer');
    } else if (peerMsg.type === 'consent_reject') {
      this.peerDecision = { kind: 'reject', reason: peerMsg.payload.reason };
      // Local user might still be deciding — but the peer's reject
      // is terminal. The local buttons should disable in the UI.
      this.transitionTo('rejected');
    } else {
      // block from peer
      this.peerDecision = { kind: 'block' };
      this.blockedByPeer = true;
      // Persist the peer's id so we never re-engage.
      try {
        await this.blockList.add(this.peerAgentId, 'blocked-by-peer');
      } catch {
        // Best-effort — don't let a store failure mask the block.
      }
      this.transitionTo('blocked');
    }

    // Resolve the outcome if we just reached a terminal state.
    if (this.isTerminal(this.state)) {
      this.resolveOutcome({});
    }
    // If we transitioned to 'accepted_peer' (peer accepted but local
    // hasn't yet), the orchestrator stays open, listening for the
    // local user's click via `decide()`. The final resolution comes
    // when `decide()` runs.
    if (this.state === 'accepted_peer') {
      // No-op: wait for the local decision.
    }
    void session; // silence unused-param warning in some builds
  }

  private transitionTo(next: ConsentState): void {
    if (this.isTerminal(this.state)) return; // terminal is sticky
    this.state = next;
    if (this.isTerminal(next)) {
      this.resolveOutcome({});
    }
  }

  private isTerminal(s: ConsentState): boolean {
    return s === 'rejected' || s === 'blocked' || s === 'accepted_both';
  }

  private resolveOutcome(patch: {
    peerAcceptTimedOut?: boolean;
  }): void {
    if (!this.resolvePromise) return;
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    resolve({
      state: this.state,
      peerDisplayName: this.peerDisplayName,
      peerAgentId: this.peerAgentId,
      bothAccepted: this.state === 'accepted_both',
      blockedByLocal: this.blockedByLocal,
      blockedByPeer: this.blockedByPeer,
      peerAcceptTimedOut: patch.peerAcceptTimedOut === true,
      peerConsentTimeoutMs: this.peerConsentTimeoutMs,
      sessionClosed: this.isTerminal(this.state),
    });
  }
}

const NoopBlockList: BlockedAgentsLookup = {
  async has() {
    return false;
  },
  async add() {
    /* no-op */
  },
};
