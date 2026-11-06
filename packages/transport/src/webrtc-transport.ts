/**
 * WebRTC transport — Phase G: an explicit `NOT_IMPLEMENTED` stub, plus
 * the contract the real implementation has to satisfy.
 *
 * ## What this file is (and is not)
 *
 * KSA 0.1 ships **no cross-network transport**. `WebRtcTransport` exists
 * so that the *shape* of the future transport is locked in, and so that
 * every caller that reaches for it gets a **typed, catchable
 * "not implemented" error** instead of a mysterious failure — or, far
 * worse, a fake "connected" state.
 *
 * Phase G (`docs/修复.md` § 十) asks for seven things. Where each one
 * is answered:
 *
 *   1. WebRTC's status is explicitly `NOT_IMPLEMENTED` — this file:
 *      every entry point throws `WebRtcNotImplementedError`.
 *   2. No false cross-network capability claims — the capability flags
 *      say `supportsWebRtc: false` (`@kindora/protocol`,
 *      `@kindora/agent`'s `buildRuntimeCapabilities`).
 *   3. No "WebRTC support" claim while unimplemented — the README,
 *      `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_STATUS.md` and the
 *      desktop UI all describe it as a stub.
 *   4. An interface contract for the follow-up work — the
 *      `WebRtcSignallingAdapter` / `WebRtcSignallingEvent` types below.
 *   5. The signalling / ICE / STUN-TURN / authentication plan — the
 *      "What the real implementation needs" section below.
 *   6. LAN and WebRTC share the identity and message-security layer —
 *      the "Same identity and message security as LAN" section below.
 *   7. WebRTC is never a way around the privacy authorisation — the
 *      "Not a privacy bypass" section below.
 *
 * ## What the real implementation needs
 *
 *   1. **Signalling.** The SDP offer/answer and the ICE candidates
 *      have to reach the other side somehow. Mode B is *manual*
 *      signalling: the two users copy a blob (or a QR payload — see
 *      `qr-payload.ts`) to each other, exactly like the LAN pairing
 *      code today. Mode C adds a signalling server; that server is a
 *      **rendezvous point only** — it must never see a KSA envelope,
 *      and it must not be able to change one.
 *   2. **ICE + STUN / TURN.** A STUN server gives the peers their
 *      server-reflexive candidates; a TURN server is what makes
 *      symmetric-NAT / strict-NAT pairs reachable at all. Both are
 *      configured through `iceServers`. STUN/TURN are a
 *      *reachability* mechanism — they are **not** an authentication
 *      mechanism, and they must never be treated as one.
 *   3. **One reliable, ordered DataChannel.** KSA envelopes are
 *      JSON objects with a strict schema; they go over a single
 *      reliable channel (`ordered: true`, `negotiated` with a fixed
 *      id) so the envelope ordering matches the application ordering.
 *   4. **The KSA layer stays exactly as it is.** The DataChannel
 *      carries the *same* `KsaMessage` envelopes the LAN transport
 *      carries — no new message type, no side channel.
 *
 * ## Same identity and message security as LAN
 *
 * DTLS-SRTP gives the DataChannel its own confidentiality and
 * integrity, but it authenticates the *channel*, not the *agent*.
 * Two different agents could sit behind the same TURN relay, so
 * DTLS alone is not enough. The WebRTC transport therefore has to use
 * **the same identity and message-security layer as the LAN
 * transport**:
 *
 *   - the envelope is signed with the **same** agent key (ES256 over
 *     the canonical envelope) and verified with the **same** pinned
 *     peer public key — the one from the pairing fingerprint (Phase
 *     A / A3), not one learned from the signalling server;
 *   - the session cipher (ECDH + HKDF + AES-GCM, `session-crypto.ts`)
 *     is negotiated **the same way**, so a WebRTC session is
 *     encrypted end-to-end between the two agents, not merely
 *     encrypted hop-by-hop to the TURN server;
 *   - `PairingSession` — the state machine, the handshake, the replay
 *     guard and the wire rate limiter — is **transport-agnostic** and
 *     is reused unchanged.
 *
 * In other words: **WebRTC changes how the bytes travel, never who
 * the bytes are from.**
 *
 * ## Not a privacy bypass
 *
 * A WebRTC channel is not a trusted channel. It reaches across the
 * internet, so it is *less* private than the LAN, not more. The
 * future implementation therefore has to sit **behind the same
 * gates** the LAN transport sits behind:
 *
 *   - the outbound profile is built by `filterProfileForOutbound`
 *     (`@kindora/protocol`) from the user's own boundaries — a
 *     WebRTC peer gets exactly the fields the user authorised, and
 *     no more;
 *   - the consent handshake (`accepted_both`, bound to the connected
 *     peer agent id) still has to complete before the authorised
 *     profile is sent;
 *   - the blacklist check and the sensitive-field guard
 *     (`assertNoSensitiveFields`, which runs **before**
 *     `transport.send()`) apply unchanged.
 *
 * There must be no code path in which "the transport is WebRTC"
 * relaxes, skips, or reorders any of those checks.
 *
 * See 开发手册.md § 18, § 19; `docs/修复.md` § 十 (Phase G).
 */
import type { KsaMessage } from '@kindora/protocol';
import type { CloseHandler, MessageHandler, PeerInfo, Transport } from './index';
import type { SessionCipher } from './session-crypto';

/**
 * The stable, machine-readable code carried by every
 * `WebRtcNotImplementedError`.
 *
 * Callers (the desktop UI in particular) branch on this rather than
 * on the message text — the message is allowed to change, the code is
 * part of the contract.
 */
export const WEBRTC_NOT_IMPLEMENTED_CODE = 'WEBRTC_NOT_IMPLEMENTED';

/**
 * The error every unimplemented WebRTC entry point throws.
 *
 * Phase G requires "未实现时调用 WebRTC 应返回明确的功能未实现错误" —
 * a *clear* not-implemented error, not a generic `Error` and not a
 * silent no-op that a caller could mistake for success.
 */
export class WebRtcNotImplementedError extends Error {
  public readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = 'WebRtcNotImplementedError';
    this.code = WEBRTC_NOT_IMPLEMENTED_CODE;
  }
}

/**
 * A remote description or an ICE candidate, delivered by the
 * signalling adapter.
 *
 * Phase G requirement 4 — the shape the follow-up implementation
 * signs against. It is deliberately transport-agnostic: a manual
 * (copy-paste) adapter and a server-based adapter produce the same
 * events.
 */
export type WebRtcSignallingEvent =
  | { readonly type: 'description'; readonly description: RTCSessionDescriptionInit }
  | { readonly type: 'candidate'; readonly candidate: RTCIceCandidateInit | null };

/**
 * How the two peers exchange their SDP and ICE candidates.
 *
 * Phase G requirement 4 — the contract for the follow-up work.
 * Implementations:
 *
 *   - **Mode B (manual).** The host produces an offer blob, the user
 *     copies it to the joiner, the joiner produces an answer blob, and
 *     the user copies that back. Nothing leaves the two machines
 *     except what the user types.
 *   - **Mode C (signalling server).** A relay passes opaque blobs
 *     between two agent ids. It is a rendezvous point, not a trusted
 *     party: it never sees a KSA envelope and it can never
 *     authenticate an agent.
 */
export interface WebRtcSignallingAdapter {
  /**
   * Hand the local description to the peer and wait for theirs.
   *
   * For the manual (Mode B) adapter this is "the user pasted the
   * blob and the peer pasted theirs back"; for the server adapter it
   * is one round trip.
   */
  exchangeDescription(local: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit>;
  /** Hand a local ICE candidate to the peer. */
  sendCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  /** Subscribe to the peer's descriptions and candidates. */
  onRemote(handler: (event: WebRtcSignallingEvent) => void): () => void;
}

export interface WebRtcTransportOptions {
  /** STUN / TURN servers, e.g. ['stun:stun.l.google.com:19302']. */
  readonly iceServers?: readonly string[];
  /** Local SDP offer to send to the remote peer (manual signaling). */
  readonly localOffer?: string;
  /**
   * Phase G requirement 4 — the signalling adapter the real
   * implementation needs. Not used by the stub (nothing here
   * connects), but part of the locked-in contract.
   */
  readonly signalling?: WebRtcSignallingAdapter;
  /**
   * Phase G requirement 6 — the session cipher is negotiated through
   * the **same** layer as the LAN transport (ECDH + HKDF + AES-GCM),
   * so a WebRTC session is encrypted end-to-end between the two
   * agents rather than only to the TURN relay.
   */
  readonly sessionCipher?: SessionCipher | null;
}

/**
 * The unimplemented WebRTC transport.
 *
 * Every entry point that would need a live DataChannel throws
 * `WebRtcNotImplementedError`. There is deliberately **no** code path
 * that resolves `connect()` successfully and **no** state in which
 * the transport looks connected — Phase G requires that no caller can
 * mistake "WebRTC" for a working cross-network link.
 *
 * The class exists so that:
 *   - `import { WebRtcTransport }` resolves in callers that want to
 *     gate the feature behind a flag;
 *   - TypeScript exhaustiveness checks fire if the real impl is added
 *     later;
 *   - the failure is **typed**, so the UI can say "cross-network
 *     pairing is not implemented yet" instead of "something went
 *     wrong".
 *
 * ### `setSessionCipher` is deliberately **not** implemented
 *
 * `Transport.setSessionCipher` is optional. `PairingSession` checks
 * for it and **refuses** to complete a handshake that asks for an
 * encrypted session on a transport that cannot carry one
 * (`pairing-session.ts:365-369` — it throws `SessionCryptoError`).
 *
 * Leaving it off the stub therefore **fails closed**: an
 * implementation that forgets to add it gets a loud, explicit
 * "this transport cannot carry an encrypted session" error instead of
 * a silently plaintext WebRTC session. It also means the future
 * implementation *has* to use the same session-cipher layer as the
 * LAN transport — there is no code path where a WebRTC session
 * quietly runs unencrypted.
 *
 * Once manual signalling (Mode B) lands, this becomes a thin wrapper
 * around `RTCPeerConnection` that exchanges envelopes over a single
 * reliable DataChannel — using the signalling adapter, the session
 * cipher and the identity layer described above.
 */
export class WebRtcTransport implements Transport {
  constructor(private readonly options: WebRtcTransportOptions = {}) {}

  async connect(_peer: PeerInfo): Promise<void> {
    throw new WebRtcNotImplementedError(
      'WebRtcTransport is not implemented (KSA 0.1). Cross-network pairing is NOT ' +
        'available — use LoopbackTransport (same process) or LanTransport (same LAN). ' +
        'See docs/修复.md § 十 (Phase G).',
    );
  }

  async send(_message: KsaMessage): Promise<void> {
    throw new WebRtcNotImplementedError(
      'WebRtcTransport.send: not implemented (KSA 0.1) — no DataChannel exists.',
    );
  }

  onMessage(_handler: MessageHandler): () => void {
    throw new WebRtcNotImplementedError(
      'WebRtcTransport.onMessage: not implemented (KSA 0.1) — no DataChannel exists.',
    );
  }

  /**
   * Phase G — the WebRTC stub has no DataChannel, so no peer-close
   * event can ever fire.
   *
   * It used to return a no-op unsubscribe (Phase 16.4 kept the
   * `Transport` shape uniform). It now throws the same typed
   * not-implemented error as every other entry point, because a
   * caller that registers a close handler on a transport that can
   * never connect would otherwise look like it had a live link.
   */
  onClose(_handler: CloseHandler): () => void {
    throw new WebRtcNotImplementedError(
      'WebRtcTransport.onClose: not implemented (KSA 0.1) — no DataChannel exists.',
    );
  }

  /**
   * Teardown is always safe.
   *
   * A transport that never connected has nothing to tear down, so
   * `disconnect()` must not throw — a caller unwinding after a failed
   * `connect()` would otherwise get a second, confusing error.
   */
  async disconnect(): Promise<void> {
    void this.options; // keep the unused-arg linter happy
  }
}
