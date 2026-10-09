/**
 * @kindora/transport
 *
 * Pluggable transport layer.
 *
 *   - `Transport`           — interface (§ 19). connect / send / onMessage / disconnect.
 *   - `LoopbackTransport`   — in-memory dev / test transport (Mode A stand-in).
 *   - `WebRtcTransport`     — interface + stub (Mode B / C, not implemented in V0.1 dev).
 *   - `PairingSession`      — finite state machine on top of any Transport.
 *   - `pairingCode*`        — short codes for manual pairing (§ 17).
 *   - `qrPayload*`          — `kindora://pair?c=...&a=...&v=0.1` URLs for QR codes.
 *
 * See 开发手册.md § 17–19, Phase 5.
 */

import type { KsaMessage } from '@kindora/protocol';

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

export interface Transport {
  connect(peer: PeerInfo): Promise<void>;
  send(message: KsaMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  disconnect(): Promise<void>;
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
export { WebRtcTransport, type WebRtcTransportOptions } from './webrtc-transport';
export {
  PairingSession,
  type PairingState,
  type PairingSnapshot,
  type PairingSessionOptions,
  type StateChangeHandler,
} from './pairing-session';
