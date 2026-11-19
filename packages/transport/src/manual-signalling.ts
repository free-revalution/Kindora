/**
 * Mode B — manual (copy/paste) signalling for WebRTC.
 *
 * The two users exchange opaque blobs out of band (chat, QR, email).
 * Nothing in these blobs is a KSA envelope; they only carry SDP and
 * ICE candidates so the DataChannel can form.
 *
 * Blob format (versioned JSON, then base64url):
 *   { v: 1, role: 'offer'|'answer', description: RTCSessionDescriptionInit,
 *     candidates: RTCIceCandidateInit[] }
 */

import type { WebRtcSignallingAdapter, WebRtcSignallingEvent } from './webrtc-transport';

export const MANUAL_SIGNAL_BLOB_VERSION = 1 as const;

export type ManualSignalRole = 'offer' | 'answer';

export interface ManualSignalPayload {
  readonly v: typeof MANUAL_SIGNAL_BLOB_VERSION;
  readonly role: ManualSignalRole;
  readonly description: RTCSessionDescriptionInit;
  readonly candidates: readonly RTCIceCandidateInit[];
}

export class ManualSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManualSignalError';
  }
}

/** Encode a signalling payload as a single pasteable string. */
export function encodeManualSignalBlob(payload: ManualSignalPayload): string {
  const json = JSON.stringify({
    v: payload.v,
    role: payload.role,
    description: payload.description,
    candidates: payload.candidates,
  });
  return base64UrlEncode(json);
}

/** Decode a pasteable blob. Throws ManualSignalError on bad input. */
export function decodeManualSignalBlob(blob: string): ManualSignalPayload {
  const trimmed = blob.trim().replace(/\s+/g, '');
  if (!trimmed) throw new ManualSignalError('Signalling blob is empty.');
  let json: string;
  try {
    json = base64UrlDecode(trimmed);
  } catch {
    throw new ManualSignalError('Signalling blob is not valid base64url.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ManualSignalError('Signalling blob is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new ManualSignalError('Signalling blob has the wrong shape.');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== MANUAL_SIGNAL_BLOB_VERSION) {
    throw new ManualSignalError(`Unsupported signalling blob version: ${String(obj.v)}`);
  }
  if (obj.role !== 'offer' && obj.role !== 'answer') {
    throw new ManualSignalError('Signalling blob role must be offer or answer.');
  }
  const description = obj.description;
  if (!description || typeof description !== 'object') {
    throw new ManualSignalError('Signalling blob is missing a description.');
  }
  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  return {
    v: MANUAL_SIGNAL_BLOB_VERSION,
    role: obj.role,
    description: description as RTCSessionDescriptionInit,
    candidates: candidates as RTCIceCandidateInit[],
  };
}

/**
 * A signalling adapter driven by the UI (or an in-process test bridge).
 *
 * Buffering: remote description/candidates applied before `onRemote`
 * subscribers exist are replayed to the next subscriber — so the joiner
 * can paste an offer blob before `connect()` starts listening.
 */
export class ManualSignallingAdapter implements WebRtcSignallingAdapter {
  private localDescription: RTCSessionDescriptionInit | null = null;
  private localCandidates: RTCIceCandidateInit[] = [];
  private remoteHandlers = new Set<(event: WebRtcSignallingEvent) => void>();
  private remoteDescriptionWaiters: Array<(d: RTCSessionDescriptionInit) => void> = [];
  private localDescriptionWaiters: Array<(d: RTCSessionDescriptionInit) => void> = [];
  private outboundReadyWaiters: Array<() => void> = [];
  private outboundReady = false;
  private bufferedRemote: WebRtcSignallingEvent[] = [];
  private role: ManualSignalRole;

  constructor(role: ManualSignalRole) {
    this.role = role;
  }

  async exchangeDescription(
    local: RTCSessionDescriptionInit,
  ): Promise<RTCSessionDescriptionInit> {
    this.localDescription = local;
    this.outboundReady = true;
    for (const w of this.localDescriptionWaiters.splice(0)) w(local);
    for (const w of this.outboundReadyWaiters.splice(0)) w();

    // Answer side only publishes; the offer already arrived via applyInboundBlob.
    if (this.role === 'answer') {
      return local;
    }

    return new Promise((resolve) => {
      this.remoteDescriptionWaiters.push(resolve);
    });
  }

  async sendCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.localCandidates.push(candidate);
  }

  onRemote(handler: (event: WebRtcSignallingEvent) => void): () => void {
    this.remoteHandlers.add(handler);
    // Replay anything pasted before connect() subscribed.
    for (const event of this.bufferedRemote) {
      handler(event);
    }
    return () => {
      this.remoteHandlers.delete(handler);
    };
  }

  /** Wait until this side has produced a local description. */
  waitForLocalDescription(): Promise<RTCSessionDescriptionInit> {
    if (this.localDescription) return Promise.resolve(this.localDescription);
    return new Promise((resolve) => {
      this.localDescriptionWaiters.push(resolve);
    });
  }

  /**
   * Resolves when the transport has finished ICE gathering and published
   * the local description via `exchangeDescription` — safe to build a blob.
   */
  waitUntilOutboundReady(): Promise<void> {
    if (this.outboundReady && this.localDescription) return Promise.resolve();
    return new Promise((resolve) => {
      this.outboundReadyWaiters.push(resolve);
    });
  }

  /** UI feeds the peer's description (from a pasted blob). */
  provideRemoteDescription(description: RTCSessionDescriptionInit): void {
    const event: WebRtcSignallingEvent = { type: 'description', description };
    this.emitRemote(event);
    for (const w of this.remoteDescriptionWaiters.splice(0)) w(description);
  }

  /** UI feeds ICE candidates from a pasted blob. */
  provideRemoteCandidates(candidates: readonly RTCIceCandidateInit[]): void {
    for (const c of candidates) {
      this.emitRemote({ type: 'candidate', candidate: c });
    }
  }

  /** Build the pasteable blob for the local side (after outbound is ready). */
  buildOutboundBlob(): string {
    if (!this.localDescription) {
      throw new ManualSignalError('No local description yet.');
    }
    return encodeManualSignalBlob({
      v: MANUAL_SIGNAL_BLOB_VERSION,
      role: this.role,
      description: this.localDescription,
      candidates: this.localCandidates,
    });
  }

  /** Convenience: wait for outbound ready, then return the pasteable blob. */
  async takeOutboundBlob(): Promise<string> {
    await this.waitUntilOutboundReady();
    return this.buildOutboundBlob();
  }

  /** Apply a pasted peer blob (description + candidates). */
  applyInboundBlob(blob: string): ManualSignalPayload {
    const payload = decodeManualSignalBlob(blob);
    this.provideRemoteDescription(payload.description);
    this.provideRemoteCandidates(payload.candidates);
    return payload;
  }

  private emitRemote(event: WebRtcSignallingEvent): void {
    this.bufferedRemote.push(event);
    for (const h of this.remoteHandlers) {
      h(event);
    }
  }
}

/**
 * Pair two ManualSignallingAdapters in-process (unit tests / Demo).
 * Relays offer → answer → offer blobs without copy/paste.
 */
export function bridgeManualSignalling(
  offerSide: ManualSignallingAdapter,
  answerSide: ManualSignallingAdapter,
): () => void {
  let closed = false;
  void (async () => {
    try {
      const offerBlob = await offerSide.takeOutboundBlob();
      if (closed) return;
      answerSide.applyInboundBlob(offerBlob);
      const answerBlob = await answerSide.takeOutboundBlob();
      if (closed) return;
      offerSide.applyInboundBlob(answerBlob);
    } catch (err) {
      if (!closed) {
        console.warn('[webrtc] bridgeManualSignalling failed:', err);
      }
    }
  })();
  return () => {
    closed = true;
  };
}

/**
 * Wait until ICE gathering is complete (or timed out).
 *
 * Used so a manual blob contains a useful candidate set in one paste.
 */
export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 8_000,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(blob: string): string {
  const padded = blob + '==='.slice((blob.length + 3) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary =
    typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
