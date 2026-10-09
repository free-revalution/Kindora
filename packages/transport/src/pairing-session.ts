/**
 * PairingSession — finite state machine over a `Transport`.
 *
 *   idle ──startHost()──► hosting ──peer connected──► connected ──disconnect()──► closed
 *   idle ──startJoin()──► joining ──pair succeeded──► connected ──disconnect()──► closed
 *
 * The session is purely an orchestrator — it does not implement any
 * network I/O itself. The actual peer discovery, SDP exchange, and
 * message delivery live in the injected Transport.
 *
 * Lifecycle:
 *
 *   const session = new PairingSession({ agentId, displayName });
 *   session.onStateChange((s) => console.log(s.state));
 *   const code = session.startHost(transport);   // returns the pairing code
 *   // ... peer arrives ...
 *   await session.send(envelope);
 *   await session.disconnect();
 *
 * See 开发手册.md § 17, Phase 5.
 */
import type { KsaMessage } from '@kindora/protocol';
import type { MessageHandler, Transport } from './index';
import { type PairingCodeOptions, generatePairingCode, normalisePairingCode } from './pairing-code';

export type PairingState = 'idle' | 'hosting' | 'joining' | 'connected' | 'closed';

export interface PairingSnapshot {
  readonly state: PairingState;
  /** The pairing code in use — present when state is hosting / joining / connected. */
  readonly code: string | null;
  /** Why we ended up here. Only set on transitions into `closed`. */
  readonly closeReason: string | null;
  /** Agent id of the connected peer, if any. */
  readonly peerAgentId: string | null;
}

export type StateChangeHandler = (snapshot: PairingSnapshot) => void;

export interface PairingSessionOptions {
  /** Local agent UUID — what we tell the peer is "us". */
  readonly agentId: string;
  /** Local display name — surfaces in the peer list / QR payload. */
  readonly displayName: string;
  /** Optional override for code length (default: 6). */
  readonly codeLength?: number;
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
  private messageHandler: MessageHandler | null = null;

  constructor(private readonly options: PairingSessionOptions) {}

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
   * Begin hosting. Generates a fresh pairing code, transitions to
   * `hosting`, and connects the transport — which enters the pairing
   * room. Returns the pairing code for the host to share with the
   * peer (typed or QR).
   *
   * Pairing is complete when the transport reports connected (the
   * peer entered the room) — the caller then invokes
   * `notifyPeerConnected()` to transition the session to `connected`.
   */
  startHost(transport: Transport, codeOptions: PairingCodeOptions = {}): string {
    this.assertState('idle');
    const code = generatePairingCode({
      length: this.options.codeLength ?? codeOptions.length ?? 6,
    });
    this.transport = transport;
    this.setState({ state: 'hosting', code, closeReason: null, peerAgentId: null });
    this.wireTransport(transport);
    // Enter the room synchronously. If a peer is already there this
    // completes the pair immediately; otherwise the host waits.
    void transport.connect({
      agentId: this.options.agentId,
      displayName: this.options.displayName,
      hint: code,
    });
    return code;
  }

  /**
   * Begin joining. Validates the code shape, then connects. If the
   * transport completes the connect synchronously (e.g. Loopback with
   * a waiting host), we transition straight to `connected`.
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
    await transport.connect({
      agentId: this.options.agentId,
      displayName: this.options.displayName,
      hint: normalised,
    });
    this.setState({ state: 'connected', peerAgentId: null });
  }

  /**
   * Called by the host when a peer has paired (e.g. LoopbackTransport
   * resolved a peer in the room). Transitions to `connected` and
   * sets the peer agent id if known.
   */
  notifyPeerConnected(peerAgentId?: string): void {
    if (this.snapshot.state !== 'hosting' && this.snapshot.state !== 'joining') {
      throw new Error(
        `notifyPeerConnected called from state "${this.snapshot.state}", expected "hosting" or "joining".`,
      );
    }
    this.setState({ state: 'connected', peerAgentId: peerAgentId ?? null });
  }

  /** Set a handler for incoming messages. Only meaningful while connected. */
  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
    if (this.transport) this.transport.onMessage(handler);
  }

  /** Send a KSA envelope to the peer. Throws if not connected. */
  async send(message: KsaMessage): Promise<void> {
    if (this.snapshot.state !== 'connected') {
      throw new Error(`Cannot send in state "${this.snapshot.state}".`);
    }
    if (!this.transport) {
      throw new Error('No transport attached.');
    }
    await this.transport.send(message);
  }

  /** Tear down the transport and move to the terminal `closed` state. */
  async disconnect(reason: string = 'user-requested'): Promise<void> {
    if (this.snapshot.state === 'closed') return;
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
    if (this.messageHandler) transport.onMessage(this.messageHandler);
  }
}
