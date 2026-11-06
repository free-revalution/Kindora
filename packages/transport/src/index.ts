/**
 * @kindora/transport
 *
 * Pluggable transport layer.
 *
 *   - `Transport`           — interface (§ 19). connect / send / onMessage / disconnect.
 *   - `LoopbackTransport`   — in-memory dev / test transport (Mode A stand-in for browser dev).
 *   - `LanTransport`        — Tauri-side UDP discovery + TCP (Mode A real, V0.1).
 *   - `WebRtcTransport`     — interface + stub (Mode B / C, not implemented in V0.1 dev).
 *   - `PairingSession`      — finite state machine on top of any Transport.
 *   - `pairingCode*`        — short codes for manual pairing (§ 17).
 *   - `qrPayload*`          — `kindora://pair?c=...&a=...&v=0.1` URLs for QR codes.
 *
 * See 开发手册.md § 17–19, Phase 5 + Phase 13.
 */

import type { KsaMessage } from '@kindora/protocol';
import type { SessionCipher } from './session-crypto';

export interface PeerInfo {
  /** The remote agent's UUID. */
  readonly agentId: string;
  /** Display name shown in the local UI. */
  readonly displayName: string;
  /**
   * Transport-specific connection hint. For LoopbackTransport and the
   * future LAN / WebRTC impls, this is the pairing code.
   */
  readonly hint?: string;
}

export type MessageHandler = (message: KsaMessage) => void;

/**
 * Phase C / C2: why a link ended.
 *
 * C2 § 5 ("前端能够收到明确的断开原因") asks for an explicit
 * disconnect reason rather than just "the connection ended". The
 * transport distinguishes three:
 *
 *   - `peer-closed` — the peer went away (EOF / reset). This is the
 *     classic `LanError::PeerClosed`.
 *   - `limit-exceeded` — the peer broke a resource limit (frame
 *     size, message rate, inbox backpressure). The Rust side reports
 *     `LanError::LimitExceeded`.
 *   - `invalid-frame` — the peer sent a frame we could not decode
 *     (e.g. invalid UTF-8). The Rust side reports
 *     `LanError::Invalid`.
 */
export type CloseReason = 'peer-closed' | 'limit-exceeded' | 'invalid-frame';

/**
 * Close handler — invoked when the transport detects the underlying
 * link has been closed by the remote side (NOT by a local
 * `disconnect()` call). The Phase 16.4 close path uses this to
 * propagate peer-side drops from the transport layer up to the
 * `PairingSession`, which then transitions to `'closed'` with a
 * `'peer-closed'` reason and lets in-flight orchestrators throw
 * `HandshakeClosedError` instead of timing out.
 *
 * Phase 16.4 contract:
 *   - Fires AT MOST ONCE per transport instance (idempotent — the
 *     `peer_closed` atomic on the Rust side collapses the read-loop
 *     EOF and any subsequent `Disconnected` inbox drain into a
 *     single observable event).
 *   - Does NOT fire for local `disconnect()` calls — those go
 *     through the watch channel on the Rust side, which explicitly
 *     leaves `peer_closed` false.
 *   - Does NOT fire for `NotConnected` errors (e.g. the host has
 *     already been torn down before any peer arrived).
 *
 * The handler runs synchronously on the polling tick that observed
 * the close. It MUST NOT throw — handlers that do are caught and
 * logged; the close event itself is still delivered to other
 * subscribers.
 *
 * Phase C / C2: the close handler now receives the reason.
 *
 * Handlers that ignore the argument stay valid — a `() => void`
 * function is assignable to `(reason: CloseReason) => void`.
 */
export type CloseHandler = (reason: CloseReason) => void;

export interface Transport {
  connect(peer: PeerInfo): Promise<void>;
  send(message: KsaMessage): Promise<void>;
  /**
   * Register a handler for incoming messages. Implementations may
   * support multiple concurrent handlers; every handler is invoked
   * for every incoming envelope. Returns an unsubscribe function.
   */
  onMessage(handler: MessageHandler): () => void;
  /**
   * Register a handler for the peer-closed event. Phase 16.4: this
   * is the half of the Transport contract that surfaces `Err(
   * LanError::PeerClosed)` from the wire to the application layer.
   *
   * Returns an unsubscribe function. The handler fires at most once
   * per transport instance; calling `disconnect()` after the
   * handler has fired is a no-op.
   */
  onClose(handler: CloseHandler): () => void;
  disconnect(): Promise<void>;
  /**
   * Phase A / A3 — install (or remove) the session cipher.
   *
   * When a cipher is installed the transport encrypts every outbound
   * envelope's payload before it reaches the wire and decrypts every
   * inbound frame before it reaches the message handlers. The
   * envelope header and the signature stay in the clear so that the
   * receiver can route and authenticate the frame.
   *
   * The method is **optional**: a transport that does not implement it
   * stays plaintext, and `PairingSession` refuses to install a cipher
   * on such a transport rather than silently downgrading the session
   * to an unencrypted one.
   */
  setSessionCipher?(cipher: SessionCipher | null): void;
}

export const TRANSPORT_PACKAGE_VERSION = '0.1.0';

export {
  ALPHABET as PAIRING_CODE_ALPHABET,
  DEFAULT_PAIRING_CODE_LENGTH,
  MIN_PAIRING_CODE_LENGTH,
  MAX_PAIRING_CODE_LENGTH,
  generatePairingCode,
  normalisePairingCode,
  isValidPairingCodeShape,
  pairingCodeEntropyBits,
  type PairingCodeOptions,
} from './pairing-code';

export { encodeQrPayload, decodeQrPayload, isKindoraPairUrl, type QrPayload } from './qr-payload';

export {
  LoopbackHub,
  LoopbackTransport,
  type LoopbackTransportOptions,
} from './loopback-transport';
export {
  WebRtcTransport,
  WebRtcNotImplementedError,
  WEBRTC_NOT_IMPLEMENTED_CODE,
  type WebRtcTransportOptions,
  type WebRtcSignallingAdapter,
  type WebRtcSignallingEvent,
} from './webrtc-transport';
export {
  LanTransport,
  type LanTransportOptions,
  type LanHostInfo,
  type LanJoinPeer,
} from './lan-transport';
export {
  PairingSession,
  DEFAULT_REPLAY_GUARD_OPTIONS,
  type PairingState,
  type PairingSnapshot,
  type PairingSessionOptions,
  type StateChangeHandler,
} from './pairing-session';

/**
 * Phase C / C3 — the connection lifecycle as the UI sees it
 * (连接中 / 已连接 / 断开 / 重连中 / 失败).
 *
 * This is deliberately separate from the pairing FSM above: the FSM
 * tracks the *protocol* handshake, this tracks the *connection*. See
 * `connection-state.ts` for why the two must not be conflated.
 */
export {
  ConnectionStateMachine,
  type ConnectionState,
  type ConnectionStateHandler,
} from './connection-state';

/**
 * Phase 16.4: typed `LanError` class for classifying Tauri IPC
 * rejections from the `lan_*` commands. See `lan-error.ts` for the
 * discrimination rules and the relationship to the Rust
 * `LanError` enum.
 *
 * Phase 16.5: also exports the pinned `Display` string constants
 * that the classifier matches against. These are part of the
 * Rust ↔ TS IPC contract — a Rust unit test
 * (`peer_closed_display_matches_ipc_contract` in
 * `apps/desktop/src-tauri/src/lan.rs`) asserts the same strings
 * on the other side.
 */
export {
  LanError,
  LAN_ERROR_PEER_CLOSED_DISPLAY,
  LAN_ERROR_NOT_CONNECTED_DISPLAY,
  LAN_ERROR_LIMIT_EXCEEDED_PREFIX,
  type LanErrorKind,
} from './lan-error';

export {
  WireRateLimiter,
  WireRateLimitExceeded,
  type WireRateLimiterOptions,
  type WireRateLimiterStats,
} from './wire-rate-limiter';

/**
 * Phase A / A3 — end-to-end session encryption.
 *
 * See `session-crypto.ts` for the design: ephemeral ECDH key
 * agreement, HKDF-SHA256 session keys, AES-256-GCM payload
 * encryption with the header + signature as additional authenticated
 * data.
 */
export {
  SESSION_KEY_INFO,
  SESSION_KEY_BYTES,
  SESSION_NONCE_BYTES,
  SESSION_NONCE_RANDOM_BYTES,
  SESSION_NONCE_COUNTER_BYTES,
  SESSION_TAG_BITS,
  SessionCryptoError,
  createSessionCipher,
  deriveSessionKey,
  computeSessionTranscript,
  sealEnvelope,
  openFrame,
  isSessionFrame,
  frameAad,
  type SessionCipher,
  type SealedBytes,
  type SessionFrame,
  type SessionTranscriptEntry,
} from './session-crypto';

/**
 * Phase A / A3 — the pairing fingerprint: an out-of-band identity
 * check derived from the host's public key.
 */
export {
  PAIRING_FINGERPRINT_LENGTH,
  derivePairingFingerprint,
  pairingFingerprintFromPublicKey,
  formatPairingFingerprint,
  fingerprintsMatch,
  crockfordBase32,
} from './pairing-fingerprint';
