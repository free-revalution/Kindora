/**
 * WebRTC DataChannel transport — Mode B (manual signalling).
 *
 * V0.1 ships a working peer connection when:
 *   1. `RTCPeerConnection` exists in the runtime (Tauri WebView / browser)
 *   2. A `WebRtcSignallingAdapter` is supplied (copy/paste or in-process)
 *
 * Without those, `connect()` throws `WebRtcNotImplementedError` so the
 * capability flag and the implementation stay honest (Phase G).
 *
 * Session encryption (`setSessionCipher`) matches Loopback/LAN: once
 * PairingSession installs a cipher, every DataChannel frame is an
 * encrypted SessionFrame.
 */

import { canonicalize, decodeEnvelope, encodeEnvelope, type KsaMessage } from '@kindora/protocol';
import {
  isSessionFrame,
  openFrame,
  sealEnvelope,
  type SessionCipher,
  type SessionFrame,
} from './session-crypto';
import type { CloseHandler, CloseReason, MessageHandler, PeerInfo, Transport } from './index';
import { waitForIceGatheringComplete } from './manual-signalling';

export const WEBRTC_NOT_IMPLEMENTED_CODE = 'WEBRTC_NOT_IMPLEMENTED' as const;

export const DEFAULT_STUN_SERVERS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
];

const DATA_CHANNEL_LABEL = 'kindora-ksa';
const MAX_PENDING_ENCRYPTED_FRAMES = 16;
const CONNECT_TIMEOUT_MS = 60_000;

export type WebRtcRole = 'offer' | 'answer';

export type WebRtcSignallingEvent =
  | { readonly type: 'description'; readonly description: RTCSessionDescriptionInit }
  | { readonly type: 'candidate'; readonly candidate: RTCIceCandidateInit | null };

export interface WebRtcSignallingAdapter {
  exchangeDescription(
    local: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit>;
  sendCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  onRemote(handler: (event: WebRtcSignallingEvent) => void): () => void;
}

export interface WebRtcTransportOptions {
  /** Who creates the offer. Default: `'offer'`. */
  readonly role?: WebRtcRole;
  readonly signalling?: WebRtcSignallingAdapter;
  /** STUN/TURN URLs. Defaults to public Google STUN. */
  readonly iceServers?: readonly string[];
  /** Override connect timeout (ms). */
  readonly connectTimeoutMs?: number;
  /**
   * Test seam — inject a peer-connection factory. Production uses
   * `globalThis.RTCPeerConnection`.
   */
  readonly peerConnectionFactory?: (config: RTCConfiguration) => RTCPeerConnection;
}

export class WebRtcNotImplementedError extends Error {
  readonly code = WEBRTC_NOT_IMPLEMENTED_CODE;
  constructor(message = 'WebRTC transport is not available in this runtime.') {
    super(message);
    this.name = 'WebRtcNotImplementedError';
  }
}

/** True when the runtime can construct an RTCPeerConnection. */
export function isWebRtcAvailable(
  factory?: WebRtcTransportOptions['peerConnectionFactory'],
): boolean {
  if (factory) return true;
  return typeof globalThis.RTCPeerConnection === 'function';
}

export class WebRtcTransport implements Transport {
  private readonly role: WebRtcRole;
  private readonly signalling: WebRtcSignallingAdapter | undefined;
  private readonly iceServers: readonly string[];
  private readonly connectTimeoutMs: number;
  private readonly peerConnectionFactory:
    | WebRtcTransportOptions['peerConnectionFactory']
    | undefined;

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private connected = false;
  private cipher: SessionCipher | null = null;
  private pendingFrames: SessionFrame[] = [];
  private messageHandlers = new Set<MessageHandler>();
  private closeHandlers = new Set<CloseHandler>();
  private unsubSignalling: (() => void) | null = null;
  private closed = false;
  /** Set when a peer-side drop already notified close handlers. */
  private peerCloseFired = false;

  constructor(options: WebRtcTransportOptions = {}) {
    this.role = options.role ?? 'offer';
    this.signalling = options.signalling;
    this.iceServers = options.iceServers ?? DEFAULT_STUN_SERVERS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.peerConnectionFactory = options.peerConnectionFactory;
  }

  async connect(_peer: PeerInfo): Promise<void> {
    if (this.closed) {
      throw new Error('WebRtcTransport: connect after disconnect.');
    }
    if (!this.signalling) {
      throw new WebRtcNotImplementedError(
        'WebRtcTransport requires a signalling adapter (Mode B manual exchange).',
      );
    }
    if (!isWebRtcAvailable(this.peerConnectionFactory)) {
      throw new WebRtcNotImplementedError(
        'RTCPeerConnection is not available in this runtime.',
      );
    }

    const signalling = this.signalling;
    const config: RTCConfiguration = {
      iceServers: this.iceServers.map((urls) => ({ urls })),
    };
    const pc = this.peerConnectionFactory
      ? this.peerConnectionFactory(config)
      : new RTCPeerConnection(config);
    this.pc = pc;

    const pendingCandidates: RTCIceCandidateInit[] = [];
    let remoteDescriptionSet = false;

    const flushCandidates = async () => {
      while (pendingCandidates.length > 0) {
        const c = pendingCandidates.shift();
        if (c) {
          try {
            await pc.addIceCandidate(c);
          } catch (err) {
            console.warn('[webrtc] addIceCandidate failed:', err);
          }
        }
      }
    };

    this.unsubSignalling = signalling.onRemote((event) => {
      if (event.type === 'description') {
        // Descriptions are applied explicitly in the offer/answer paths below.
        // Buffering them here would race with setRemoteDescription.
        return;
      }
      if (event.candidate) {
        if (!remoteDescriptionSet) {
          pendingCandidates.push(event.candidate);
        } else {
          void pc.addIceCandidate(event.candidate).catch((err) => {
            console.warn('[webrtc] addIceCandidate failed:', err);
          });
        }
      }
    });

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      void signalling.sendCandidate(ev.candidate.toJSON());
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.failClose('peer-closed', { notifyPeerClose: true });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        this.failClose('peer-closed', { notifyPeerClose: true });
      }
    };

    const channelReady = new Promise<RTCDataChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebRtcTransport: connect timed out waiting for DataChannel.'));
      }, this.connectTimeoutMs);

      const settle = (ch: RTCDataChannel) => {
        clearTimeout(timer);
        this.wireChannel(ch);
        resolve(ch);
      };

      if (this.role === 'offer') {
        const ch = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
        ch.onopen = () => settle(ch);
        ch.onerror = () => {
          clearTimeout(timer);
          reject(new Error('WebRtcTransport: DataChannel error before open.'));
        };
      } else {
        pc.ondatachannel = (ev) => {
          const ch = ev.channel;
          if (ch.readyState === 'open') {
            settle(ch);
          } else {
            ch.onopen = () => settle(ch);
          }
        };
      }
    });

    try {
      if (this.role === 'offer') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGatheringComplete(pc);
        const remote = await signalling.exchangeDescription(pc.localDescription ?? offer);
        await pc.setRemoteDescription(remote);
        remoteDescriptionSet = true;
        await flushCandidates();
      } else {
        const offerDesc = await waitForRemoteDescription(signalling);
        await pc.setRemoteDescription(offerDesc);
        remoteDescriptionSet = true;
        await flushCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForIceGatheringComplete(pc);
        await signalling.exchangeDescription(pc.localDescription ?? answer);
      }

      this.channel = await channelReady;
      this.connected = true;
    } catch (err) {
      // Surface the failure to PairingSession / UI instead of leaving a
      // half-open PeerConnection that looks "connecting" forever.
      this.failClose('peer-closed', { notifyPeerClose: true });
      throw err;
    }
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  async send(message: KsaMessage): Promise<void> {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('WebRtcTransport: send before channel is open.');
    }
    const wire = this.cipher
      ? canonicalize(await sealEnvelope(message, this.cipher))
      : encodeEnvelope(message);
    this.channel.send(wire);
  }

  setSessionCipher(cipher: SessionCipher | null): void {
    this.cipher = cipher;
    if (cipher) {
      void this.flushPendingFrames();
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async disconnect(_reason = 'user-requested'): Promise<void> {
    // Local disconnect does NOT fire onClose (mirrors Loopback/LAN).
    this.failClose('peer-closed', { notifyPeerClose: false });
  }

  isConnected(): boolean {
    return this.connected && this.channel?.readyState === 'open';
  }

  private wireChannel(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.onmessage = (ev) => {
      void this.handleIncoming(String(ev.data));
    };
    ch.onclose = () => {
      this.failClose('peer-closed', { notifyPeerClose: true });
    };
  }

  private async handleIncoming(raw: string): Promise<void> {
    const message = await this.decodeWire(raw);
    if (!message) return;
    for (const h of this.messageHandlers) h(message);
  }

  private async decodeWire(raw: string): Promise<KsaMessage | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (isSessionFrame(parsed)) {
      if (!this.cipher) {
        if (this.pendingFrames.length >= MAX_PENDING_ENCRYPTED_FRAMES) {
          this.pendingFrames.shift();
        }
        this.pendingFrames.push(parsed);
        return null;
      }
      try {
        return await openFrame(parsed, this.cipher);
      } catch (err) {
        console.warn('[webrtc] could not decrypt an inbound session frame:', err);
        return null;
      }
    }
    return decodeEnvelope(raw);
  }

  private async flushPendingFrames(): Promise<void> {
    if (this.pendingFrames.length === 0) return;
    const cipher = this.cipher;
    if (!cipher) return;
    const pending = this.pendingFrames;
    this.pendingFrames = [];
    for (const frame of pending) {
      let decoded: KsaMessage | null = null;
      try {
        decoded = await openFrame(frame, cipher);
      } catch (err) {
        console.warn('[webrtc] a queued session frame failed to decrypt:', err);
      }
      if (!decoded) continue;
      for (const h of this.messageHandlers) h(decoded);
    }
  }

  private failClose(
    reason: CloseReason,
    opts: { notifyPeerClose: boolean },
  ): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.unsubSignalling?.();
    this.unsubSignalling = null;
    try {
      this.channel?.close();
    } catch {
      /* ignore */
    }
    this.channel = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    if (!opts.notifyPeerClose || this.peerCloseFired) return;
    this.peerCloseFired = true;
    for (const h of this.closeHandlers) {
      try {
        h(reason);
      } catch {
        /* ignore */
      }
    }
  }
}

function waitForRemoteDescription(
  signalling: WebRtcSignallingAdapter,
): Promise<RTCSessionDescriptionInit> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsub?.();
      reject(new Error('WebRtcTransport: timed out waiting for remote offer.'));
    }, CONNECT_TIMEOUT_MS);
    unsub = signalling.onRemote((event) => {
      if (event.type !== 'description') return;
      clearTimeout(timer);
      unsub?.();
      resolve(event.description);
    });
  });
}
