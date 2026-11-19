/**
 * Same-device WebRTC lab signalling via `BroadcastChannel`.
 *
 * Two windows on one machine join the same room (fingerprint) and
 * exchange SDP + ICE without copy/paste. BroadcastChannel does not
 * buffer: a late joiner sends `need`, and whoever already has a local
 * description re-posts it.
 */

import type { WebRtcSignallingAdapter, WebRtcSignallingEvent } from './webrtc-transport';
import type { ManualSignalRole } from './manual-signalling';

const CHANNEL_PREFIX = 'kindora-webrtc-lab:';

type WireMessage =
  | { readonly kind: 'description'; readonly description: RTCSessionDescriptionInit }
  | { readonly kind: 'candidate'; readonly candidate: RTCIceCandidateInit }
  | { readonly kind: 'need' };

export class BroadcastSignallingAdapter implements WebRtcSignallingAdapter {
  private readonly channel: BroadcastChannel;
  private readonly role: ManualSignalRole;
  private remoteHandlers = new Set<(event: WebRtcSignallingEvent) => void>();
  private remoteDescriptionWaiters: Array<(d: RTCSessionDescriptionInit) => void> = [];
  private localDescription: RTCSessionDescriptionInit | null = null;
  private bufferedRemote: WebRtcSignallingEvent[] = [];
  private closed = false;

  constructor(roomId: string, role: ManualSignalRole) {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is not available in this runtime.');
    }
    this.role = role;
    this.channel = new BroadcastChannel(`${CHANNEL_PREFIX}${roomId}`);
    this.channel.onmessage = (ev: MessageEvent<WireMessage>) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.kind === 'need') {
        if (this.localDescription) {
          this.channel.postMessage({
            kind: 'description',
            description: this.localDescription,
          } satisfies WireMessage);
        }
        return;
      }
      if (data.kind === 'description') {
        this.emitRemote({ type: 'description', description: data.description });
        for (const w of this.remoteDescriptionWaiters.splice(0)) {
          w(data.description);
        }
        return;
      }
      if (data.kind === 'candidate') {
        this.emitRemote({ type: 'candidate', candidate: data.candidate });
      }
    };

    // Ask the peer to re-send if they already published.
    this.channel.postMessage({ kind: 'need' } satisfies WireMessage);
  }

  async exchangeDescription(
    local: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    this.localDescription = local;
    this.channel.postMessage({ kind: 'description', description: local } satisfies WireMessage);
    if (this.role === 'answer') {
      return local;
    }
    return new Promise((resolve) => {
      this.remoteDescriptionWaiters.push(resolve);
    });
  }

  async sendCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.channel.postMessage({ kind: 'candidate', candidate } satisfies WireMessage);
  }

  onRemote(handler: (event: WebRtcSignallingEvent) => void): () => void {
    this.remoteHandlers.add(handler);
    for (const event of this.bufferedRemote) {
      handler(event);
    }
    return () => {
      this.remoteHandlers.delete(handler);
    };
  }

  private emitRemote(event: WebRtcSignallingEvent): void {
    this.bufferedRemote.push(event);
    for (const h of this.remoteHandlers) {
      h(event);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
  }
}

export function isBroadcastSignallingAvailable(): boolean {
  return typeof BroadcastChannel === 'function';
}
