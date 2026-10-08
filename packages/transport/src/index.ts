/**
 * @kindora/transport
 *
 * Pluggable transport layer. V0.1 target: LAN / localhost + manual
 * WebRTC signaling. Concrete implementations land in Phase 5.
 *
 * See 开发手册.md § 18–19.
 */

export interface PeerInfo {
  readonly agentId: string;
  readonly displayName: string;
  /** Free-form, transport-specific connection hint (e.g. pairing code). */
  readonly hint?: string;
}

export interface ProtocolMessage {
  readonly protocol: 'KSA';
  readonly version: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly type: string;
  readonly sender: string;
  readonly payload: unknown;
}

export type MessageHandler = (message: ProtocolMessage) => void;

export interface Transport {
  connect(peer: PeerInfo): Promise<void>;
  send(message: ProtocolMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  disconnect(): Promise<void>;
}

export const TRANSPORT_PACKAGE_VERSION = '0.1.0';
