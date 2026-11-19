/**
 * Mode C — HTTP long-poll signalling for WebRTC.
 *
 * Two peers join the same room (usually the host fingerprint) on a
 * signalling base URL. Descriptions and ICE candidates are posted and
 * polled; nothing here is a KSA envelope.
 *
 * The companion server lives at `tools/kindora-signalling-server.mjs`
 * (zero npm deps — Node `http` only). Kindora does **not** host a
 * public signalling service; you run your own or point Settings at one.
 */

import type { WebRtcSignallingAdapter, WebRtcSignallingEvent } from './webrtc-transport';
import type { ManualSignalRole } from './manual-signalling';

export type HttpSignallingWire =
  | { readonly kind: 'description'; readonly description: RTCSessionDescriptionInit }
  | { readonly kind: 'candidate'; readonly candidate: RTCIceCandidateInit };

export interface HttpSignallingOptions {
  /** Base URL without trailing slash, e.g. `http://127.0.0.1:8787`. */
  readonly baseUrl: string;
  /** Room id — typically the host identity fingerprint. */
  readonly roomId: string;
  readonly role: ManualSignalRole;
  /** Optional fetch implementation (tests). */
  readonly fetchImpl?: typeof fetch;
  /** Long-poll interval when the server returns empty (ms). */
  readonly pollIntervalMs?: number;
}

export class HttpSignallingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpSignallingError';
  }
}

export function isHttpSignallingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Mode C signalling adapter.
 *
 * `exchangeDescription` posts the local SDP and waits until the peer's
 * description appears (offer waits for answer; answer returns immediately
 * after posting, matching Manual/Broadcast answer semantics).
 */
export class HttpSignallingAdapter implements WebRtcSignallingAdapter {
  private readonly baseUrl: string;
  private readonly roomId: string;
  private readonly role: ManualSignalRole;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private remoteHandlers = new Set<(event: WebRtcSignallingEvent) => void>();
  private remoteDescriptionWaiters: Array<(d: RTCSessionDescriptionInit) => void> = [];
  /** Replay buffer so late `onRemote` subscribers still see prior peer SDP/ICE. */
  private bufferedRemote: WebRtcSignallingEvent[] = [];
  private seen = 0;
  private closed = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HttpSignallingOptions) {
    const base = options.baseUrl.trim().replace(/\/+$/, '');
    if (!isHttpSignallingUrl(base)) {
      throw new HttpSignallingError(`Invalid signalling base URL: ${options.baseUrl}`);
    }
    if (!options.roomId.trim()) {
      throw new HttpSignallingError('Signalling room id must not be empty.');
    }
    this.baseUrl = base;
    this.roomId = options.roomId.trim();
    this.role = options.role;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.pollIntervalMs = options.pollIntervalMs ?? 400;
    void this.ensureJoined();
    this.schedulePoll();
  }

  async exchangeDescription(
    local: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    await this.post({ kind: 'description', description: local });
    if (this.role === 'answer') {
      return local;
    }
    const already = this.bufferedRemote.find((e) => e.type === 'description');
    if (already && already.type === 'description') {
      return already.description;
    }
    return new Promise((resolve) => {
      this.remoteDescriptionWaiters.push(resolve);
    });
  }

  async sendCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.post({ kind: 'candidate', candidate });
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

  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private roomUrl(): string {
    return `${this.baseUrl}/v1/rooms/${encodeURIComponent(this.roomId)}`;
  }

  private async ensureJoined(): Promise<void> {
    const res = await this.fetchImpl(`${this.roomUrl()}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: this.role }),
    });
    if (!res.ok) {
      throw new HttpSignallingError(`Signalling join failed (${res.status}).`);
    }
  }

  private async post(message: HttpSignallingWire): Promise<void> {
    const res = await this.fetchImpl(`${this.roomUrl()}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.role, ...message }),
    });
    if (!res.ok) {
      throw new HttpSignallingError(`Signalling post failed (${res.status}).`);
    }
  }

  private schedulePoll(): void {
    if (this.closed) return;
    this.pollTimer = setTimeout(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  private async pollOnce(): Promise<void> {
    if (this.closed) return;
    try {
      const res = await this.fetchImpl(
        `${this.roomUrl()}/messages?after=${this.seen}&waitMs=2500`,
        { method: 'GET' },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          messages?: Array<{
            id: number;
            from: string;
            kind: string;
            description?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          }>;
        };
        for (const msg of body.messages ?? []) {
          if (typeof msg.id === 'number' && msg.id >= this.seen) this.seen = msg.id + 1;
          if (msg.from === this.role) continue;
          if (msg.kind === 'description' && msg.description) {
            const event: WebRtcSignallingEvent = {
              type: 'description',
              description: msg.description,
            };
            this.emitRemote(event);
            for (const w of this.remoteDescriptionWaiters.splice(0)) {
              w(msg.description);
            }
          } else if (msg.kind === 'candidate' && msg.candidate) {
            this.emitRemote({ type: 'candidate', candidate: msg.candidate });
          }
        }
      }
    } catch {
      // Transient network errors — keep polling until close().
    }
    this.schedulePoll();
  }

  private emitRemote(event: WebRtcSignallingEvent): void {
    this.bufferedRemote.push(event);
    for (const h of this.remoteHandlers) h(event);
  }
}
