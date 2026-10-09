/**
 * WebRTC transport — interface contract + not-implemented stub.
 *
 * The real WebRTC DataChannel transport requires:
 *   1. A signaling channel (out of scope for V0.1 dev — see
 *      开发手册.md § 18 Mode B / Mode C).
 *   2. STUN / TURN configuration for cross-network reach.
 *   3. SDP offer / answer exchange, ICE candidate trickling.
 *
 * The shape is locked in here so callers (PairingSession, the desktop
 * UI) can wire against it now and we can drop in the implementation
 * later without churning the contract.
 *
 * See 开发手册.md § 18, § 19.
 */
import type { KsaMessage } from '@kindora/protocol';
import type { MessageHandler, PeerInfo, Transport } from './index';

export interface WebRtcTransportOptions {
  /** STUN / TURN servers, e.g. ['stun:stun.l.google.com:19302']. */
  readonly iceServers?: readonly string[];
  /** Local SDP offer to send to the remote peer (manual signaling). */
  readonly localOffer?: string;
}

/**
 * Throws on every method. The class exists so that:
 *   - `import { WebRtcTransport }` resolves in callers that want to
 *     gate the feature behind a flag.
 *   - TypeScript exhaustiveness checks fire if the real impl is added
 *     later.
 *
 * Once manual signaling (Mode B) lands, this becomes a thin wrapper
 * around `RTCPeerConnection` that exchanges envelopes over a single
 * reliable DataChannel.
 */
export class WebRtcTransport implements Transport {
  constructor(private readonly options: WebRtcTransportOptions = {}) {}

  async connect(_peer: PeerInfo): Promise<void> {
    throw new Error(
      'WebRtcTransport is not implemented in V0.1 dev. Use LoopbackTransport, ' +
        'or implement Mode B (manual WebRTC signaling) — see 开发手册.md § 18.',
    );
  }

  async send(_message: KsaMessage): Promise<void> {
    throw new Error('WebRtcTransport.send: transport not connected.');
  }

  onMessage(_handler: MessageHandler): void {
    throw new Error('WebRtcTransport.onMessage: transport not connected.');
  }

  async disconnect(): Promise<void> {
    void this.options; // keep the unused-arg linter happy
  }
}
