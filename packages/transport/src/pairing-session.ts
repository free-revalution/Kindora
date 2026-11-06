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
import type { KsaMessage, KsaSignature, SessionKeyExchange } from '@kindora/protocol';
import {
  SIGNATURE_ALG,
  SIGNING_SCHEME,
  assertNoSensitiveFields,
  base64ToBytes,
  base64UrlToBytes,
  buildSigningInput,
  bytesToBase64Url,
  deriveKeyId,
  deriveSharedSecret,
  generateEphemeralKeyPair,
  importEphemeralPublicKey,
  validateEnvelope,
  verifyEnvelopeSignature,
  ReplayGuard,
  type EphemeralKeyPair,
  type EnvelopeSigner,
  type ReplayGuardOptions,
} from '@kindora/protocol';
import type { MessageHandler, Transport } from './index';
import { WireRateLimiter, type WireRateLimiterOptions } from './wire-rate-limiter';
import { type PairingCodeOptions, generatePairingCode, normalisePairingCode } from './pairing-code';
import { fingerprintsMatch, derivePairingFingerprint } from './pairing-fingerprint';
import {
  SessionCryptoError,
  computeSessionTranscript,
  createSessionCipher,
  deriveSessionKey,
  type SessionCipher,
} from './session-crypto';

/**
 * Phase A / A3 — the default anti-replay window.
 *
 * Two independent protections live in `ReplayGuard`:
 *
 *   1. **messageId dedup** — the real anti-replay mechanism. It has **no
 *      clock dependency**: an envelope whose `messageId` has been seen
 *      before is a replay, full stop.
 *   2. **timestamp freshness** — catches an envelope old enough that it
 *      has already been evicted from the dedup cache.
 *
 * The freshness window is deliberately **symmetric and generous**
 * (5 minutes in both directions) rather than the protocol module's
 * default 30-second future-skew allowance. The reason is a failure mode
 * we can reason about without running anything: the guard compares the
 * peer's timestamp against **our own clock**, so a device whose clock is
 * more than `maxSkewMs` ahead of ours would have *every* one of its
 * envelopes rejected, and pairing would fail in a way that looks like
 * "the peer never answered". A 30-second allowance makes that far too
 * easy to hit; 5 minutes makes it a genuinely broken clock.
 *
 * The cost is that a replayed envelope must be at least 5 minutes old to
 * be caught by freshness alone — but a *fresh* replay (the common case)
 * is caught by the dedup regardless of age.
 */
export const DEFAULT_REPLAY_GUARD_OPTIONS: ReplayGuardOptions = Object.freeze({
  maxAgeMs: 5 * 60 * 1000,
  maxSkewMs: 5 * 60 * 1000,
  capacity: 1024,
});

export type PairingState =
  'idle' | 'hosting' | 'joining' | 'tcp-connected' | 'connected' | 'closed';

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
  /**
   * Phase A / A3 — true once the session key has been agreed and the
   * transport is encrypting payloads with AES-256-GCM.
   *
   * False during the handshake (the key does not exist yet) and false
   * for a peer that did not offer an ephemeral key.
   */
  readonly sessionEncrypted: boolean;
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
  /**
   * Optional signer for outbound envelopes (Phase A / A2).
   *
   * When a signer is supplied:
   *   - every outbound envelope is signed before it goes on the wire;
   *   - every inbound envelope must carry a valid signature, or it is
   *     dropped and counted as a failure.
   *
   * When no signer is supplied the session behaves exactly as it did
   * before Phase A: envelopes go out unsigned and nothing is verified.
   * The two are switched together on purpose — a session that signs but
   * does not verify would authenticate itself to a peer that is free to
   * impersonate it.
   */
  readonly signer?: EnvelopeSigner | null;
  /**
   * How many inbound signature failures to tolerate before the session
   * tears the connection down with `closeReason = 'signature-invalid'`.
   * Defaults to 3.
   */
  readonly maxSignatureFailures?: number;
  /**
   * Phase A / A3 — the fingerprint the user believes they are talking
   * to (the pairing code they typed).
   *
   * When set, the peer that presents a `hello` must produce exactly
   * this fingerprint from its own agent id + public key. A mismatch is
   * a **hard** failure: the session is closed with
   * `closeReason = 'peer-fingerprint-mismatch'` and no data is
   * exchanged.
   *
   * `null` (the default) means "no out-of-band check was requested" —
   * the session is still authenticated by the A2 signatures, it just
   * is not bound to a fingerprint the user read out.
   */
  readonly expectedPeerFingerprint?: string | null;
  /**
   * Phase A / A3 — anti-replay guard for inbound envelopes.
   *
   * Task book A3.8 ("实现消息重放保护") and its test case
   * ("重放历史握手数据时连接失败").
   *
   * Defaults to a fresh `ReplayGuard` with the window described in
   * {@link DEFAULT_REPLAY_GUARD_OPTIONS}. Pass `null` to disable the
   * check (not recommended).
   *
   * The guard is consulted **before** the signature check, so it applies
   * to unsigned sessions too — otherwise a session without a signer
   * (which is a legitimate configuration: "no usable WebCrypto") would
   * have no replay protection at all.
   */
  readonly replayGuard?: ReplayGuard | null;
  /**
   * Phase A / A3 — options for the default replay guard.
   *
   * Only used when `replayGuard` is left unset. `null` disables the
   * guard entirely.
   */
  readonly replayGuardOptions?: ReplayGuardOptions | null;
}

export class PairingSession {
  private snapshot: PairingSnapshot = {
    state: 'idle',
    code: null,
    closeReason: null,
    peerAgentId: null,
    sessionEncrypted: false,
  };
  private transport: Transport | null = null;
  private readonly stateHandlers = new Set<StateChangeHandler>();
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly rateLimiter: WireRateLimiter | null;
  private readonly guardSensitiveFields: boolean;
  /** Phase A / A2 — the local signer, or null when signing is off. */
  private readonly signer: EnvelopeSigner | null;
  /** Phase A / A2 — how many bad signatures we tolerate. */
  private readonly maxSignatureFailures: number;
  /**
   * Phase A / A3 — the anti-replay guard, or null when it is disabled.
   *
   * Consulted on **every** inbound envelope, before the signature
   * check, so that an unsigned session is not left without replay
   * protection.
   */
  private readonly replayGuard: ReplayGuard | null;
  /** Phase A / A3 — how many inbound envelopes the replay guard rejected. */
  private replayRejections = 0;
  /**
   * Phase A / A2 — the peer's identity public key, latched from the
   * first `hello` we accepted. Every later message is verified against
   * it.
   */
  private peerPublicKeySpki: Uint8Array | null = null;
  /** Phase A / A2 — the peer's key id, latched alongside the key. */
  private peerKeyId: string | null = null;
  /** Phase A / A2 — the peer's agent id, latched from their `hello`. */
  private peerAgentIdFromHello: string | null = null;
  /** Phase A / A2 — consecutive inbound signature failures. */
  private signatureFailures = 0;
  /** Phase A / A2 — why the last signature failed (diagnostics only). */
  private lastSignatureError: string | null = null;
  /**
   * Phase A / A2 — serialises inbound verification so that messages are
   * dispatched to the handlers in the order they arrived.
   */
  private inboundChain: Promise<void> = Promise.resolve();
  /**
   * Phase A / A3 — our ephemeral ECDH key pair for the session key
   * exchange. Created lazily, on the first `sessionKeyExchange()` call.
   */
  private ephemeral: EphemeralKeyPair | null = null;
  private ephemeralPromise: Promise<EphemeralKeyPair> | null = null;
  /**
   * Phase A / A3 — the peer's ephemeral public key (base64url SPKI),
   * latched from the `hello` we accepted.
   */
  private peerEphemeralPublicKey: string | null = null;
  /** Phase A / A3 — true once our own `hello` has gone out. */
  private helloSent = false;
  /** Phase A / A3 — the session cipher, once the key has been agreed. */
  private sessionCipher: SessionCipher | null = null;

  constructor(private readonly options: PairingSessionOptions) {
    this.rateLimiter =
      options.rateLimiter === null
        ? null
        : (options.rateLimiter ?? new WireRateLimiter(options.rateLimiterOptions));
    this.guardSensitiveFields = options.guardSensitiveFields ?? true;
    this.signer = options.signer ?? null;
    this.maxSignatureFailures = Math.max(1, options.maxSignatureFailures ?? 3);
    // Phase A / A3 — the replay guard. `replayGuard: null` disables it
    // outright; `replayGuardOptions: null` does the same; otherwise we
    // build a guard from the options (or the documented defaults).
    this.replayGuard =
      options.replayGuard === null
        ? null
        : (options.replayGuard ??
          (options.replayGuardOptions === null
            ? null
            : new ReplayGuard(options.replayGuardOptions ?? DEFAULT_REPLAY_GUARD_OPTIONS)));
  }

  /** Current state snapshot — immutable copy. */
  current(): PairingSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Phase A / A3 — the ephemeral key material this side offers for the
   * session key exchange.
   *
   * The caller (the orchestrator) puts this into the `hello` payload
   * so the peer can run ECDH with us. Returns `null` when the runtime
   * has no usable WebCrypto — the session then stays plaintext and
   * says so through `capabilities.supportsSessionEncryption`.
   */
  async sessionKeyExchange(): Promise<SessionKeyExchange | null> {
    try {
      const pair = await this.ensureEphemeral();
      return {
        ephemeralPublicKey: bytesToBase64Url(pair.publicKeySpki),
        keyId: await deriveKeyId(pair.publicKeySpki),
      };
    } catch {
      // No crypto, no session encryption. Not fatal: the session falls
      // back to a signed-but-unencrypted session, and the capability
      // flags tell the peer that is the case.
      return null;
    }
  }

  /**
   * Phase A / A3 — create (once) the ephemeral ECDH key pair used for
   * the session key exchange.
   */
  private ensureEphemeral(): Promise<EphemeralKeyPair> {
    if (!this.ephemeralPromise) {
      this.ephemeralPromise = generateEphemeralKeyPair().then((pair) => {
        this.ephemeral = pair;
        return pair;
      });
    }
    return this.ephemeralPromise;
  }

  /**
   * Phase A / A3 — derive the session key and install the cipher.
   *
   * Runs only once **both** conditions hold:
   *
   *   - our own `hello` has been sent (the peer needs our ephemeral
   *     key before it can derive anything), and
   *   - the peer's `hello` has been accepted (that is where its
   *     ephemeral key comes from).
   *
   * Installing the cipher earlier would be a deadlock: the peer has no
   * key yet and would drop the frame.
   */
  private async maybeInstallSessionCipher(): Promise<void> {
    if (this.sessionCipher) return;
    if (!this.helloSent) return;
    const peerEphemeral = this.peerEphemeralPublicKey;
    if (!peerEphemeral) return;
    const local = this.ephemeral;
    if (!local) return;
    const transport = this.transport;
    if (!transport) return;
    if (typeof transport.setSessionCipher !== 'function') {
      throw new SessionCryptoError(
        'this transport cannot carry an encrypted session, so the pairing cannot be completed',
      );
    }

    let peerSpki: Uint8Array;
    try {
      peerSpki = base64UrlToBytes(peerEphemeral);
    } catch {
      throw new SessionCryptoError("the peer's ephemeral key is not valid base64url");
    }
    const peerKey = await importEphemeralPublicKey(peerSpki);
    const shared = await deriveSharedSecret(local.privateKey, peerKey);
    const transcript = computeSessionTranscript([
      {
        agentId: this.options.agentId,
        ephemeralPublicKey: bytesToBase64Url(local.publicKeySpki),
      },
      {
        agentId: this.peerAgentIdFromHello ?? '',
        ephemeralPublicKey: peerEphemeral,
      },
    ]);
    const sessionKey = await deriveSessionKey(shared, transcript);
    const cipher = await createSessionCipher(sessionKey);
    this.sessionCipher = cipher;
    transport.setSessionCipher(cipher);
    this.setState({ sessionEncrypted: true });
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
  startHost(
    transport: Transport,
    codeOptions: PairingCodeOptions & { seed?: string } = {},
  ): string {
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
    //
    // Phase C / C3 § 7: `connect()` is de-duplicated, so a second
    // caller joins the attempt already in flight. The rejection is
    // caught here because `startHost` returns the code
    // synchronously — it cannot await the connect — and an unhandled
    // rejection would take the whole process down instead of
    // surfacing as a failed pairing.
    void transport
      .connect({
        agentId: this.options.agentId,
        displayName: this.options.displayName,
        hint: code,
      })
      .catch((err: unknown) => {
        console.warn('[pairing] transport.connect failed:', err);
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
    // Phase C / C3 § 2: the link is going away, so stop consuming
    // transport messages. The session-level handlers (the ones the
    // orchestrator registered) are untouched — they are this
    // session's own business.
    this.releaseMessageHandler();
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // ignore — the transport may already be gone.
      }
    }
    if (this.current().state === 'closed') return;
    // Phase A / A3: the session key dies with the handshake.
    this.sessionCipher?.destroy();
    this.sessionCipher = null;
    this.setState({
      state: 'closed',
      closeReason: reason,
      peerAgentId: null,
      sessionEncrypted: false,
    });
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
   *
   * Phase A / A2: the session owns a single transport-level handler, so
   * an inbound envelope is rate-limited and signature-checked exactly
   * once, no matter how many handlers are registered.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
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
   *
   * Phase A / A2: when a signer is configured the envelope is validated
   * and signed before it goes on the wire. The signature covers the
   * *validated* payload, which is exactly what the peer hashes after
   * its own validation — so both sides always sign/verify the same
   * bytes.
   */
  async send(message: KsaMessage): Promise<void> {
    if (this.snapshot.state !== 'connected' && this.snapshot.state !== 'tcp-connected') {
      throw new Error(`Cannot send in state "${this.snapshot.state}".`);
    }
    if (!this.transport) {
      throw new Error('No transport attached.');
    }
    this.rateLimiter?.checkOutbound();
    if (this.guardSensitiveFields) {
      assertNoSensitiveFields(message);
    }
    // Phase A / A3 — fail closed. If the peer offered a session key and
    // we somehow could not install the cipher, sending in the clear
    // would be a silent downgrade.
    if (message.type !== 'hello' && this.peerEphemeralPublicKey && !this.sessionCipher) {
      throw new Error(
        'the session should be encrypted by now, but the session cipher could not be installed.',
      );
    }
    const outbound = await this.signOutbound(message);
    await this.transport.send(outbound);
    if (outbound.type === 'hello') {
      // Phase A / A3 — our `hello` is on the wire. Only now may the
      // session cipher be installed: the peer needs our ephemeral key
      // before it can decrypt anything, and a `hello` sealed with a
      // key the peer does not have yet would be a deadlock.
      this.helloSent = true;
      await this.maybeInstallSessionCipher();
    }
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
    // Phase C / C3 § 2: stop consuming transport messages before the
    // link goes down. The session is finished; anything that arrives
    // during the teardown belongs to a peer we are leaving.
    this.releaseMessageHandler();
    try {
      if (this.transport) await this.transport.disconnect();
    } finally {
      this.transport = null;
      // Phase A / A3: the session key dies with the session.
      this.sessionCipher?.destroy();
      this.sessionCipher = null;
      this.setState({
        state: 'closed',
        closeReason: reason,
        peerAgentId: null,
        sessionEncrypted: false,
      });
    }
  }

  /**
   * Phase C / C3 § 3 + § 5 + § 6 — reset the session so that it can
   * pair again.
   *
   * This is what makes a reconnect *safe* rather than merely
   * possible:
   *
   *   - § 5 — the FSM goes back to `idle`, so `startHost` /
   *     `startJoin` **must** be called again. That re-runs the whole
   *     handshake: the peer's `hello` is verified again, the
   *     fingerprint is checked again, and the session key is agreed
   *     again. Nothing carries over from the dead link.
   *   - § 6 — every piece of per-connection handshake state is
   *     dropped, **including the ephemeral key pair**. Reusing the
   *     old ephemeral key would make the new session key derivable
   *     from the old transcript.
   *   - § 2 — the transport-level subscriptions are released, so the
   *     old transport stops feeding this session.
   *
   * The transport is disconnected but **not** reconnected here: the
   * caller decides whether to re-bind the same transport instance or
   * to build a new one.
   *
   * Note on the anti-replay guard: it and its rejection counter are
   * deliberately **not** reset. Replay protection has to survive a
   * reconnect — an envelope captured before the drop must still be
   * rejected afterwards.
   */
  async resetForReconnect(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (this.closeUnsub) {
      this.closeUnsub();
      this.closeUnsub = null;
    }
    this.releaseMessageHandler();
    if (transport) {
      try {
        await transport.disconnect();
      } catch {
        // ignore — the link is usually already gone.
      }
    }
    // Phase C / C3 § 6: the session key dies with the link.
    this.sessionCipher?.destroy();
    this.sessionCipher = null;
    // Phase C / C3 § 5: drop the per-connection handshake state
    // wholesale. The ephemeral key pair goes with it — the next
    // handshake mints a *fresh* one.
    this.ephemeral = null;
    this.ephemeralPromise = null;
    this.helloSent = false;
    this.peerEphemeralPublicKey = null;
    this.peerPublicKeySpki = null;
    this.peerKeyId = null;
    this.peerAgentIdFromHello = null;
    this.signatureFailures = 0;
    this.lastSignatureError = null;
    this.inboundChain = Promise.resolve();
    // Back to `idle` so `startHost` / `startJoin` have to be called
    // again — a reconnect redoes the whole handshake.
    this.setState({
      state: 'idle',
      code: null,
      closeReason: null,
      peerAgentId: null,
      sessionEncrypted: false,
    });
  }

  private assertState(expected: PairingState): void {
    if (this.snapshot.state !== expected) {
      throw new Error(
        `Invalid state transition: expected "${expected}", got "${this.snapshot.state}".`,
      );
    }
  }

  private wireTransport(transport: Transport): void {
    // Phase A / A2: ONE transport-level handler. It rate-limits and
    // signature-checks each inbound envelope exactly once, then fans the
    // envelope out to the registered message handlers.
    //
    // Phase C / C3 § 2: the unsubscribe is kept so the handler can be
    // detached when the session is torn down or reset. See
    // `releaseMessageHandler`.
    this.releaseMessageHandler();
    this.messageUnsub = transport.onMessage((msg) => {
      this.dispatchInbound(msg);
    });
  }

  /**
   * Phase A / A2 — the single entry point for inbound envelopes.
   *
   * The rate limiter is consulted once per envelope (not once per
   * registered handler). When signing is enabled the envelope is
   * verified asynchronously; the verifications are chained so that the
   * handlers still see the envelopes in arrival order.
   */
  private dispatchInbound(message: KsaMessage): void {
    if (this.rateLimiter && !this.rateLimiter.checkInbound()) return;
    // Phase A / A3 — anti-replay. Runs **before** the signature check so
    // that a session without a signer is not left unprotected: a
    // replayed envelope is dropped and never reaches a handler.
    if (this.replayGuard) {
      try {
        this.replayGuard.accept(message);
      } catch {
        // `ReplayRejected` — duplicate messageId, or a timestamp outside
        // the freshness window. The envelope is dropped silently: from
        // the peer's point of view it simply never arrived.
        this.replayRejections += 1;
        return;
      }
    }
    if (!this.signer) {
      this.emit(message);
      return;
    }
    this.inboundChain = this.inboundChain
      .then(() => this.verifyInbound(message))
      .then((accepted) => {
        if (accepted) this.emit(message);
      })
      .catch((err: unknown) => {
        // A verification error must never take the message pump down.
        console.warn('[pairing] inbound signature check threw:', err);
      });
  }

  /** Fan an accepted envelope out to the registered handlers. */
  private emit(message: KsaMessage): void {
    for (const h of this.messageHandlers) {
      try {
        h(message);
      } catch (err) {
        // One misbehaving handler must not stop the others.
        console.warn('[pairing] message handler threw:', err);
      }
    }
  }

  /**
   * Phase A / A2 — verify an inbound envelope's detached signature.
   *
   * Returns `true` when the envelope may be dispatched.
   *
   * The peer's identity key is latched from the first `hello` we accept:
   * that message carries the key it was signed with, and every later
   * message has to verify against that same key. A `hello` whose
   * `keyId` does not match its own public key is rejected outright.
   */
  private async verifyInbound(message: KsaMessage): Promise<boolean> {
    const signature = message.signature;
    if (!signature) {
      await this.onSignatureFailure('unsigned-envelope');
      return false;
    }

    let spki: Uint8Array;
    if (message.type === 'hello') {
      const raw = (message.payload as { publicKey?: unknown }).publicKey;
      if (typeof raw !== 'string' || raw.length === 0) {
        await this.onSignatureFailure('hello-without-public-key');
        return false;
      }
      try {
        spki = base64ToBytes(raw);
      } catch {
        await this.onSignatureFailure('hello-public-key-not-base64');
        return false;
      }
      const expectedKeyId = await deriveKeyId(spki);
      if (expectedKeyId !== signature.keyId) {
        await this.onSignatureFailure('hello-key-id-mismatch');
        return false;
      }
      this.peerPublicKeySpki = spki;
      this.peerKeyId = signature.keyId;
      this.peerAgentIdFromHello = message.sender;
    } else {
      if (!this.peerPublicKeySpki) {
        await this.onSignatureFailure('no-peer-key-yet');
        return false;
      }
      if (this.peerAgentIdFromHello && message.sender !== this.peerAgentIdFromHello) {
        await this.onSignatureFailure('sender-does-not-match-peer');
        return false;
      }
      spki = this.peerPublicKeySpki;
      if (signature.keyId !== this.peerKeyId) {
        await this.onSignatureFailure('key-id-changed');
        return false;
      }
    }

    const raw = await verifyEnvelopeSignature({
      envelope: message,
      recipient: this.signingRecipientFor(message.type),
      publicKeySpki: spki,
      signature,
    });
    if (!raw) {
      await this.onSignatureFailure('bad-signature');
      return false;
    }
    this.signatureFailures = 0;

    if (message.type === 'hello') {
      const accepted = await this.onPeerHelloAccepted(message, spki);
      if (!accepted) return false;
    }
    return true;
  }

  /**
   * Phase A / A3 — the checks that only make sense once the peer's
   * `hello` has a **valid signature**:
   *
   *   1. the fingerprint the user was shown must match the one the
   *      peer's key actually produces (out-of-band identity check);
   *   2. a peer that advertises `supportsSessionEncryption` must offer
   *      an ephemeral key — otherwise the claim is a lie;
   *   3. the peer's ephemeral key is latched and the session key is
   *      derived (once our own `hello` is on the wire).
   *
   * Returns `false` when the handshake must not continue.
   */
  private async onPeerHelloAccepted(message: KsaMessage, spki: Uint8Array): Promise<boolean> {
    const payload = message.payload as {
      publicKey?: unknown;
      capabilities?: { supportsSessionEncryption?: unknown };
      sessionKeyExchange?: { ephemeralPublicKey?: unknown };
    };

    // 1 — the out-of-band fingerprint.
    const expected = this.options.expectedPeerFingerprint;
    if (expected) {
      const actual = await derivePairingFingerprint(message.sender, spki);
      if (!fingerprintsMatch(actual, expected)) {
        await this.failSecurity('peer-fingerprint-mismatch');
        return false;
      }
    }

    // 2 — the capability claim must be backed by an ephemeral key.
    const claimsSessionEncryption = payload.capabilities?.supportsSessionEncryption === true;
    const exchange = payload.sessionKeyExchange;
    const peerEphemeral =
      exchange && typeof exchange.ephemeralPublicKey === 'string' && exchange.ephemeralPublicKey
        ? exchange.ephemeralPublicKey
        : null;
    if (claimsSessionEncryption && !peerEphemeral) {
      await this.failSecurity('peer-advertises-session-encryption-without-a-key');
      return false;
    }

    // 3 — latch the ephemeral key and try to establish the cipher.
    if (peerEphemeral) {
      this.peerEphemeralPublicKey = peerEphemeral;
      try {
        await this.maybeInstallSessionCipher();
      } catch (err) {
        await this.failSecurity(
          `session-key-agreement-failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
    return true;
  }

  /**
   * The recipient that binds a message to this session.
   *
   * The sender signs with the **peer's** agent id; the receiver verifies
   * with its **own** agent id. `hello` is the exception: it is sent
   * before the peer is known, so it signs with an empty recipient.
   */
  private signingRecipientFor(type: string): string {
    if (type === 'hello') return '';
    return this.options.agentId;
  }

  /**
   * Phase A / A2 — sign an outbound envelope (or pass it through when
   * signing is off).
   *
   * The envelope is validated first so that the bytes we sign are the
   * bytes the peer will hash: the validator normalises the payload
   * identically on both sides.
   */
  private async signOutbound(message: KsaMessage): Promise<KsaMessage> {
    const signer = this.signer;
    if (!signer) return message;
    const validated = validateEnvelope(message);
    // The signature binds the message to the session: the sender signs
    // with the **peer's** agent id, the peer verifies with **our** id.
    //
    // The peer's id is learned from their `hello` (`peerAgentIdFromHello`);
    // `snapshot.peerAgentId` is the same value once the session reaches
    // 'connected'. Before either is known the only message we may send
    // is the `hello` itself, which signs with an empty recipient.
    const recipient =
      validated.type === 'hello'
        ? ''
        : (this.peerAgentIdFromHello ?? this.snapshot.peerAgentId ?? '');
    const input = await buildSigningInput(validated, recipient);
    const value = await signer.sign(input);
    const signature: KsaSignature = {
      alg: SIGNATURE_ALG,
      keyId: signer.keyId,
      value,
      signedFields: SIGNING_SCHEME,
    };
    return { ...validated, signature } as KsaMessage;
  }

  /**
   * Count an inbound signature failure and, once the budget is spent,
   * tear the session down with `closeReason = 'signature-invalid'`.
   */
  private async onSignatureFailure(detail: string): Promise<void> {
    this.signatureFailures += 1;
    this.lastSignatureError = detail;
    if (this.signatureFailures < this.maxSignatureFailures) return;
    const state = this.current().state;
    if (state === 'closed') return;
    if (state === 'hosting' || state === 'joining' || state === 'tcp-connected') {
      await this.failHandshake('signature-invalid');
    } else {
      await this.disconnect('signature-invalid');
    }
  }

  /**
   * The last inbound signature failure, for diagnostics.
   * `null` when no failure has been seen.
   */
  lastSignatureFailure(): string | null {
    return this.lastSignatureError;
  }

  /**
   * Phase A / A3 — how many inbound envelopes the anti-replay guard
   * rejected (duplicate `messageId`, or outside the freshness window).
   *
   * Diagnostics only. A non-zero count on a healthy session means
   * something is replaying traffic to us.
   */
  replayRejectionCount(): number {
    return this.replayRejections;
  }

  /**
   * The peer's key id, once a `hello` has been accepted. `null` before
   * that.
   */
  peerKeyIdValue(): string | null {
    return this.peerKeyId;
  }

  /**
   * Phase A / A3 — a security failure that ends the session
   * **immediately**, without spending the retry budget.
   *
   * Used for the checks where "try again" makes no sense: a
   * fingerprint that does not match the one the user was shown, a peer
   * whose capability claim is contradicted by its own payload, and a
   * session key agreement that failed.
   */
  private async failSecurity(reason: string): Promise<void> {
    this.signatureFailures += 1;
    this.lastSignatureError = reason;
    const state = this.current().state;
    if (state === 'closed') return;
    if (state === 'hosting' || state === 'joining' || state === 'tcp-connected') {
      await this.failHandshake(reason);
    } else {
      await this.disconnect(reason);
    }
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

  /**
   * Phase C / C3 § 2 — the unsubscribe for the session's single
   * transport-level message handler.
   *
   * The session registers exactly one handler on the transport (so
   * every inbound envelope is rate-limited and signature-checked
   * exactly once). Without keeping the unsubscribe, a session that is
   * reset for a reconnect leaves its handler attached to the *old*
   * transport — which then keeps the session alive and keeps feeding
   * it messages from a peer that is gone. That is the "重复连接造成
   * 资源泄漏" the task book warns about in C3 § 2.
   */
  private messageUnsub: (() => void) | null = null;

  /**
   * Phase C / C3 § 2 — stop consuming transport messages.
   *
   * Idempotent: calling it when no handler is installed is a no-op.
   */
  private releaseMessageHandler(): void {
    if (this.messageUnsub) {
      this.messageUnsub();
      this.messageUnsub = null;
    }
  }

  private installCloseHandler(transport: Transport): void {
    if (this.closeUnsub) this.closeUnsub();
    // Phase C / C2: the transport now reports *why* the link ended
    // (`peer-closed`, `limit-exceeded`, `invalid-frame`), so the
    // session's `closeReason` carries the specific cause instead of
    // a generic "peer-closed" for every teardown.
    this.closeUnsub = transport.onClose((reason) => {
      void this.failHandshake(reason);
    });
  }
}
