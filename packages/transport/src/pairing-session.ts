/**
 * PairingSession — finite state machine over a `Transport`.
 *
 *   idle ──startHost()──► hosting ──notifyTransportConnected()──► tcp-connected ──notifyHelloReceived()──► connected ──disconnect()──► closed
 *   idle ──startJoin()──► joining ──notifyTransportConnected()──► tcp-connected ──notifyHelloReceived()──► connected ──disconnect()──► closed
 *                                       │
 *                                       └──failHandshake()──► closed
 *
 * The session is purely an orchestrator — it does not implement any
 * network I/O itself. The actual peer discovery, SDP exchange, and
 * message delivery live in the injected Transport.
 *
 * Phase 15 (V0.1): the FSM now distinguishes three wire-up milestones
 *   (a) transport link is up  →  'tcp-connected'
 *   (b) peer's `hello` validated →  'connected'
 *   (c) session closed        →  'closed'
 * `startJoin()` no longer auto-promotes to `'connected'` after
 * `transport.connect()` resolves — that promotion is reserved for
 * `notifyHelloReceived()`, which the orchestrator (or a higher layer)
 * calls only after the peer's `hello` envelope has been received and
 * validated. The previous `notifyPeerConnected(peerAgentId?)` method
 * is kept as a thin alias for `notifyTransportConnected()` and no
 * longer accepts a peer id.
 *
 * Lifecycle:
 *
 *   const session = new PairingSession({ agentId, displayName });
 *   session.onStateChange((s) => console.log(s.state));
 *   const code = session.startHost(transport);   // returns the pairing code
 *   // ... transport reports TCP link up ...
 *   session.notifyTransportConnected();          // hosting → tcp-connected
 *   // ... peer `hello` arrives, is validated ...
 *   session.notifyHelloReceived(peerAgentId);    // tcp-connected → connected
 *   await session.send(envelope);
 *   await session.disconnect();
 *
 * See 开发手册.md § 17, Phase 5 + Phase 15.
 */
import type { KsaMessage } from '@kindora/protocol';
import { assertNoSensitiveFields } from '@kindora/protocol';
import type { MessageHandler, Transport } from './index';
import { WireRateLimiter, type WireRateLimiterOptions } from './wire-rate-limiter';
import { type PairingCodeOptions, generatePairingCode, normalisePairingCode } from './pairing-code';

export type PairingState =
  | 'idle'
  | 'hosting'
  | 'joining'
  | 'tcp-connected'
  | 'connected'
  | 'closed';

export interface PairingSnapshot {
  readonly state: PairingState;
  /** The pairing code in use — present when state is hosting / joining / tcp-connected / connected. */
  readonly code: string | null;
  /** Why we ended up here. Only set on transitions into `closed`. */
  readonly closeReason: string | null;
  /**
   * Agent id of the connected peer. Set ONLY when state is `connected`
   * (the id is locked in by `notifyHelloReceived(peerAgentId)` once the
   * peer's `hello` envelope has been validated). Before that, the
   * transport is up but the peer has not authenticated.
   */
  readonly peerAgentId: string | null;
}

export type StateChangeHandler = (snapshot: PairingSnapshot) => void;

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PairingSessionOptions {
  /** Local agent UUID — what we tell the peer is "us". */
  readonly agentId: string;
  /** Local display name — surfaces in the peer list / QR payload. */
  readonly displayName: string;
  /** Optional override for code length (default: 6). */
  readonly codeLength?: number;
  /**
   * Optional wire rate limiter — defaults to a fresh `WireRateLimiter`
   * with V0.1-friendly capacities (10 outbound/sec, 30 inbound/sec).
   * Pass `null` to disable rate limiting (not recommended for prod).
   */
  readonly rateLimiter?: WireRateLimiter | null;
  /** Configure the default rate limiter (ignored if `rateLimiter` set). */
  readonly rateLimiterOptions?: WireRateLimiterOptions;
  /**
   * Whether to run the sensitive-field guard on outbound envelopes.
   * Defaults to true. Defense in depth on top of § 11 / § 16.
   */
  readonly guardSensitiveFields?: boolean;
}

export class PairingSession {
  private snapshot: PairingSnapshot = {
    state: 'idle',
    code: null,
    closeReason: null,
    peerAgentId: null,
  };
  private transport: Transport | null = null;
  private readonly stateHandlers = new Set<StateChangeHandler>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly rateLimiter: WireRateLimiter | null;
  private readonly guardSensitiveFields: boolean;

  constructor(private readonly options: PairingSessionOptions) {
    this.rateLimiter =
      options.rateLimiter === null
        ? null
        : (options.rateLimiter ?? new WireRateLimiter(options.rateLimiterOptions));
    this.guardSensitiveFields = options.guardSensitiveFields ?? true;
  }

  /** Current state snapshot — immutable copy. */
  current(): PairingSnapshot {
    return { ...this.snapshot };
  }

  onStateChange(handler: StateChangeHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private setState(patch: Partial<PairingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const h of this.stateHandlers) h(this.snapshot);
  }

  /**
   * Begin hosting. Generates a fresh pairing code (or uses a
   * caller-provided one via `codeOptions.seed`), transitions to
   * `hosting`, and asks the transport to connect.
   *
   * The caller MAY pass `codeOptions.seed` to use a pre-minted code
   * — this is the LAN path: the Rust transport needs the code before
   * `PairingSession` can wire up, so the service generates it
   * independently and threads the same value into both the transport
   * bind and the session. For idle transports, `transport.connect`
   * inside this method runs the joiner's UDP discover and may
   * prematurely flip the transport into `'join'` mode. The caller
   * MUST pre-bind the transport (so its `mode` is already `'host'`
   * or `'join'`) before invoking this method, otherwise `connect` is
   * a real network call rather than a confirmation no-op. This is
   * the root cause of the Phase 16.3 § 5.1 follow-up: pre-bind the
   * transport, then call `startHost(transport, { seed: code })`.
   *
   * Returns the pairing code for the host to share with the peer
   * (typed or QR). The session does NOT transition to `connected`
   * here — the caller must call `notifyTransportConnected()` when
   * the wire is up and `notifyHelloReceived(peerAgentId)` once the
   * peer's `hello` envelope has been received and validated.
   */
  startHost(transport: Transport, codeOptions: PairingCodeOptions & { seed?: string } = {}): string {
    this.assertState('idle');
    const code =
      typeof codeOptions === 'object' && codeOptions.seed !== undefined
        ? generatePairingCode(codeOptions) // honour the seed (validates shape)
        : generatePairingCode({
            length: this.options.codeLength ?? codeOptions.length ?? 6,
          });
    this.transport = transport;
    this.setState({ state: 'hosting', code, closeReason: null, peerAgentId: null });
    this.wireTransport(transport);
    this.installCloseHandler(transport);
    // Enter the room synchronously. If a peer is already there this
    // completes the pair immediately; otherwise the host waits.
    //
    // Invariant: the caller MUST have pre-bound the transport (e.g.
    // `await lanTransport.startHost(code)`) so the implicit
    // `transport.connect({hint: code})` below is a no-op. With the
    // transport in 'idle' mode this call would instead run the
    // joiner's UDP discover + dial — see Phase 16.3 note above.
    void transport.connect({
      agentId: this.options.agentId,
      displayName: this.options.displayName,
      hint: code,
    });
    return code;
  }

  /**
   * Begin joining. Validates the code shape, then connects. Once the
   * transport reports the wire is up the FSM transitions to
   * `tcp-connected` — NOT `connected`. The session is not considered
   * `connected` until `notifyHelloReceived(peerAgentId)` is called
   * with the validated peer's id.
   */
  async startJoin(transport: Transport, code: string): Promise<void> {
    this.assertState('idle');
    const normalised = normalisePairingCode(code);
    if (!normalised) {
      throw new Error(`Invalid pairing code shape: ${JSON.stringify(code)}`);
    }
    this.transport = transport;
    this.setState({ state: 'joining', code: normalised, closeReason: null, peerAgentId: null });
    this.wireTransport(transport);
    this.installCloseHandler(transport);
    await transport.connect({
      agentId: this.options.agentId,
      displayName: this.options.displayName,
      hint: normalised,
    });
    // Wire is up; the protocol session is NOT yet ready — we must
    // wait for the peer's `hello` envelope to be received and
    // validated before transitioning to 'connected'.
    this.setState({ state: 'tcp-connected', peerAgentId: null });
  }

  /**
   * Called by the host/joiner service once the underlying transport
   * reports the wire link is up (host: a joiner accepted the TCP
   * connection; joiner: the TCP dial succeeded).
   *
   * Transitions: `hosting` | `joining` → `tcp-connected`. The peer
   * is NOT yet authenticated; `notifyHelloReceived(peerAgentId)`
   * must still be called once the peer's `hello` envelope has been
   * received and validated.
   */
  notifyTransportConnected(): void {
    if (this.snapshot.state !== 'hosting' && this.snapshot.state !== 'joining') {
      throw new Error(
        `notifyTransportConnected called from state "${this.snapshot.state}", expected "hosting" or "joining".`,
      );
    }
    this.setState({ state: 'tcp-connected', peerAgentId: null });
  }

  /**
   * Called by the orchestrator (or any consumer) after a `hello`
   * envelope from the peer has been received and validated. The
   * `peerAgentId` argument is the envelope's `sender` field — it
   * must be a non-empty UUID-shaped string.
   *
   * Transitions: `tcp-connected` → `connected`. The peer's id is
   * locked in at this point; the orchestrator can now drive the
   * `profile_exchange` / `match_request` / `match_response` flow.
   */
  notifyHelloReceived(peerAgentId: string): void {
    if (this.snapshot.state !== 'tcp-connected') {
      throw new Error(
        `notifyHelloReceived called from state "${this.snapshot.state}", expected "tcp-connected".`,
      );
    }
    if (typeof peerAgentId !== 'string' || !peerAgentId) {
      throw new Error('notifyHelloReceived: peerAgentId must be a non-empty string.');
    }
    if (!UUID_LIKE.test(peerAgentId)) {
      throw new Error(
        `notifyHelloReceived: peerAgentId must be a UUID-shaped string (got ${JSON.stringify(peerAgentId)}).`,
      );
    }
    if (peerAgentId === this.options.agentId) {
      throw new Error('notifyHelloReceived: peerAgentId must not equal self agentId.');
    }
    this.setState({ state: 'connected', peerAgentId });
  }

  /**
   * Mark the handshake as failed and tear down the transport. Used
   * by the orchestrator when the peer's `hello` is invalid, never
   * arrives, or the wire disconnects mid-handshake.
   *
   * No-op from `closed` (idempotent). From any other non-terminal
   * state, transitions to `closed` with the given `reason`. The
   * transport is disconnected; its `disconnect()` errors are
   * swallowed because the wire is already gone in most failure paths.
   *
   * Phase 16.4: this is also the path the peer-close event handler
   * (`onClose` from the transport) takes. A `failHandshake('peer-
   * closed')` call from the close handler transitions the FSM and
   * sets `closeReason` so an in-flight orchestrator can distinguish
   * a peer drop from a generic timeout.
   */
  async failHandshake(reason: string): Promise<void> {
    if (this.snapshot.state === 'closed') return;
    if (
      this.snapshot.state !== 'tcp-connected' &&
      this.snapshot.state !== 'hosting' &&
      this.snapshot.state !== 'joining'
    ) {
      return;
    }
    // Phase 16.4: if a transport's onClose already drove us into
    // 'closed' between the check above and the teardown, the
    // subsequent `disconnect()` is idempotent and a no-op. We
    // therefore re-check the state right before `setState` to
    // avoid a stray transition that would overwrite an
    // already-set `closeReason`. Reading via `current()` (which
    // returns a fresh, type-narrowed snapshot) is intentional —
    // using `this.snapshot` directly would let TypeScript's
    // narrowing see the post-await state as still one of
    // hosting/joining/tcp-connected and flag a tautology.
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // ignore — the transport may already be gone.
      }
    }
    if (this.current().state === 'closed') return;
    this.setState({ state: 'closed', closeReason: reason, peerAgentId: null });
  }

  /**
   * @deprecated Use `notifyTransportConnected()` to signal the wire
   * is up, and `notifyHelloReceived(peerAgentId)` once the peer's
   * `hello` envelope has been validated. This method is kept for
   * backward compatibility; it now transitions to `'tcp-connected'`
   * (the peer hello is NOT yet validated), matching the V0.1 wire
   * semantics. The optional `peerAgentId` argument is ignored — the
   * id is no longer trusted at the transport-link milestone.
   */
  notifyPeerConnected(peerAgentId?: string): void {
    void peerAgentId;
    this.notifyTransportConnected();
  }

  /**
   * Register a handler for incoming messages. Multiple handlers may
   * be registered — every handler is invoked for every incoming
   * envelope. Returns an unsubscribe function.
   *
   * Inbound envelopes that exceed the configured wire rate limit are
   * silently dropped (they don't reach the registered handlers).
   */
  onMessage(handler: MessageHandler): () => void {
    const wrapped: MessageHandler = (msg) => {
      if (this.rateLimiter && !this.rateLimiter.checkInbound()) return;
      handler(msg);
    };
    this.messageHandlers.add(wrapped);
    if (this.transport) this.transport.onMessage(wrapped);
    return () => {
      this.messageHandlers.delete(wrapped);
    };
  }

  /**
   * Send a KSA envelope to the peer. Allowed from `tcp-connected`
   * and `connected`. From `tcp-connected` the session is allowed to
   * send because the orchestrator's own `hello` must be written
   * before the peer's `hello` can be received and validated. Throws
   * when:
   *   - the session isn't `tcp-connected` or `connected`
   *   - the wire rate limiter refuses the send (WireRateLimitExceeded)
   *   - the payload contains a sensitive field (SensitiveFieldError)
   */
  async send(message: KsaMessage): Promise<void> {
    if (
      this.snapshot.state !== 'connected' &&
      this.snapshot.state !== 'tcp-connected'
    ) {
      throw new Error(`Cannot send in state "${this.snapshot.state}".`);
    }
    if (!this.transport) {
      throw new Error('No transport attached.');
    }
    this.rateLimiter?.checkOutbound();
    if (this.guardSensitiveFields) {
      assertNoSensitiveFields(message);
    }
    await this.transport.send(message);
  }

  /** Tear down the transport and move to the terminal `closed` state. */
  async disconnect(reason: string = 'user-requested'): Promise<void> {
    if (this.snapshot.state === 'closed') return;
    // Phase 16.4: drop the close handler BEFORE disconnecting so a
    // local cancel does NOT fire the peer-close event. The
    // transport's onClose is reserved for remote-side drops — a
    // local `disconnect()` followed by a re-bind (on a fresh
    // transport) is the only way a `PairingSession` re-enters the
    // room.
    if (this.closeUnsub) {
      this.closeUnsub();
      this.closeUnsub = null;
    }
    try {
      if (this.transport) await this.transport.disconnect();
    } finally {
      this.transport = null;
      this.setState({ state: 'closed', closeReason: reason, peerAgentId: null });
    }
  }

  private assertState(expected: PairingState): void {
    if (this.snapshot.state !== expected) {
      throw new Error(
        `Invalid state transition: expected "${expected}", got "${this.snapshot.state}".`,
      );
    }
  }

  private wireTransport(transport: Transport): void {
    for (const h of this.messageHandlers) transport.onMessage(h);
  }

  /**
   * Phase 16.4: subscribe to the transport's `onClose` event. When
   * the transport observes a peer-side drop (TCP EOF / RST), it
   * fires this handler. The session then transitions to `'closed'`
   * with `closeReason = 'peer-closed'` so a waiting orchestrator
   * can throw `HandshakeClosedError` instead of timing out.
   *
   * The handler does NOT fire for local `disconnect()` calls
   * because the transport's `disconnect()` clears the close
   * handlers and `PairingSession.disconnect` unsubscribes
   * synchronously before the teardown.
   *
   * `failHandshake` is idempotent — if the user already cancelled
   * (e.g. clicked Disconnect) the close handler is a no-op.
   */
  private closeUnsub: (() => void) | null = null;
  private installCloseHandler(transport: Transport): void {
    if (this.closeUnsub) this.closeUnsub();
    this.closeUnsub = transport.onClose(() => {
      void this.failHandshake('peer-closed');
    });
  }
}
