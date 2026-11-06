/**
 * Loopback transport — in-memory duplex Transport for browser dev /
 * unit tests. Two ends registered on the same `LoopbackHub` exchange
 * messages through the hub without any real network.
 *
 * This stands in for V0.1 Mode A (LAN / localhost) when running in
 * a browser dev context where no UDP / TCP discovery is possible.
 * The Transport contract is identical, so swapping in a real LAN or
 * WebRTC implementation later does not change any caller code.
 *
 * Pure JS — no timers, no async I/O beyond the MicrotaskQueue.
 *
 * See 开发手册.md § 18 Mode A, § 19.
 */
import { canonicalize, decodeEnvelope, encodeEnvelope, type KsaMessage } from '@kindora/protocol';
import type { CloseHandler, MessageHandler, PeerInfo, Transport } from './index';
import {
  isSessionFrame,
  openFrame,
  sealEnvelope,
  type SessionCipher,
  type SessionFrame,
} from './session-crypto';

/**
 * Phase A / A3 — how many encrypted frames may wait for the session
 * cipher before the oldest ones are dropped.
 *
 * The cipher is installed asynchronously (the session has to verify
 * the peer's `hello` first), but the transport decodes frames as they
 * arrive. A frame that lands in that window cannot be decrypted yet.
 * We queue it rather than drop it — dropping would silently lose the
 * peer's first encrypted message. The cap keeps a peer that never
 * completes the handshake from growing the queue without bound.
 */
const MAX_PENDING_ENCRYPTED_FRAMES = 32;

interface Endpoint {
  readonly id: string;
  readonly messageHandlers: Set<MessageHandler>;
  connected: boolean;
  /**
   * Phase A / A3 — the owning transport's frame decoder.
   *
   * The hub deliberately does **not** decode: it forwards the raw wire
   * string and lets the receiving transport decrypt and parse it. That
   * keeps the decryption key inside the transport that owns it and
   * keeps the hub a pure bus.
   */
  decodeFrame: (raw: string) => Promise<KsaMessage | null>;
}

/**
 * Shared bus. Pass the same instance to two LoopbackTransports; the
 * hub routes messages between matched endpoints by pairing code.
 *
 * Lifecycle: a hub lives as long as something references it. Call
 * `reset()` to disconnect everyone (e.g. on test teardown).
 */
export class LoopbackHub {
  private readonly endpoints = new Map<string, Endpoint>();
  /** Map of pairingCode → list of registered endpoints waiting for a peer. */
  private readonly rooms = new Map<string, Set<string>>();

  register(id: string): Endpoint {
    const ep: Endpoint = {
      id,
      messageHandlers: new Set(),
      connected: false,
      // Replaced by the owning transport as soon as it constructs
      // itself. The default drops the frame rather than throwing, so a
      // hub that is used without a transport cannot crash.
      decodeFrame: async () => null,
    };
    this.endpoints.set(id, ep);
    return ep;
  }

  unregister(id: string): void {
    const ep = this.endpoints.get(id);
    if (!ep) return;
    for (const set of this.rooms.values()) set.delete(id);
    this.endpoints.delete(id);
  }

  /** Put an endpoint into a pairing-code room, or join it to an existing peer. */
  joinRoom(endpointId: string, pairingCode: string): PeerInfo | null {
    const ep = this.endpoints.get(endpointId);
    if (!ep) throw new Error(`Unknown endpoint: ${endpointId}`);

    let room = this.rooms.get(pairingCode);
    if (!room) {
      room = new Set();
      this.rooms.set(pairingCode, room);
    }

    // Look for an existing peer already waiting in this room.
    for (const otherId of room) {
      if (otherId === endpointId) continue;
      const other = this.endpoints.get(otherId);
      if (!other) continue;
      room.delete(otherId);
      ep.connected = true;
      other.connected = true;
      return { agentId: other.id, displayName: other.id };
    }

    // Nobody there — wait.
    room.add(endpointId);
    return null;
  }

  /**
   * Deliver a raw wire frame from one endpoint to its paired peer.
   *
   * The hub forwards the raw string; the receiving endpoint's own
   * transport decrypts and parses it (Phase A / A3).
   */
  async deliver(fromId: string, rawJson: string): Promise<boolean> {
    const from = this.endpoints.get(fromId);
    if (!from || !from.connected) return false;
    // The hub does not know the peer id — broadcast to every other
    // connected endpoint. (For the V0.1 use case, a hub has at most
    // two connected endpoints.)
    for (const [id, ep] of this.endpoints) {
      if (id === fromId) continue;
      if (!ep.connected) continue;
      const decoded = await ep.decodeFrame(rawJson);
      if (!decoded) continue;
      for (const h of ep.messageHandlers) h(decoded);
    }
    return true;
  }

  /** Disconnect both sides of every pair and clear all rooms. */
  reset(): void {
    for (const ep of this.endpoints.values()) ep.connected = false;
    this.rooms.clear();
  }
}

export interface LoopbackTransportOptions {
  readonly endpointId: string;
  readonly hub: LoopbackHub;
}

/**
 * LoopbackTransport — one endpoint of a LoopbackHub. Construct two
 * with the same hub and matching pairing codes to exchange envelopes.
 */
export class LoopbackTransport implements Transport {
  private readonly endpoint: Endpoint;
  /** Phase A / A3 — the session cipher, once the session key is agreed. */
  private cipher: SessionCipher | null = null;
  /**
   * Phase A / A3 — encrypted frames that arrived before the cipher
   * was installed. See `MAX_PENDING_ENCRYPTED_FRAMES`.
   */
  private pendingFrames: SessionFrame[] = [];

  constructor(private readonly options: LoopbackTransportOptions) {
    this.endpoint = options.hub.register(options.endpointId);
    this.endpoint.decodeFrame = (raw: string) => this.decodeWire(raw);
  }

  async connect(peer: PeerInfo): Promise<void> {
    // LoopbackTransport pairs via the pairing code, not the PeerInfo
    // passed in. The PeerInfo is what callers have; we require the
    // pairing code to live alongside the PeerInfo as `hint`.
    const code = peer.hint;
    if (!code) {
      throw new Error('LoopbackTransport.connect requires PeerInfo.hint to be a pairing code.');
    }
    // joinRoom returns peer info on immediate pair, or null if the
    // endpoint is the first to enter the room. Either way the call
    // succeeds — caller checks `isConnected()` to know which.
    this.options.hub.joinRoom(this.endpoint.id, code);
  }

  async send(message: KsaMessage): Promise<void> {
    if (!this.endpoint.connected) {
      throw new Error('LoopbackTransport: send before connect.');
    }
    // Phase A / A3: with a session cipher installed the payload is
    // encrypted; the header and the signature stay in the clear.
    const wire = this.cipher
      ? canonicalize(await sealEnvelope(message, this.cipher))
      : encodeEnvelope(message);
    const ok = await this.options.hub.deliver(this.endpoint.id, wire);
    if (!ok) {
      throw new Error('LoopbackTransport: no peer to deliver to.');
    }
  }

  /**
   * Phase A / A3 — install (or clear) the session cipher.
   *
   * Installing a cipher also flushes any encrypted frame that arrived
   * while the handshake was still in flight.
   */
  setSessionCipher(cipher: SessionCipher | null): void {
    this.cipher = cipher;
    if (cipher) {
      void this.flushPendingFrames();
    }
  }

  /**
   * Phase A / A3 — decrypt the frames that were waiting for the cipher.
   *
   * A frame that fails to authenticate is dropped: it is either
   * corrupt or was tampered with on the wire.
   */
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
        console.warn('[loopback] a queued session frame failed to decrypt:', err);
      }
      if (!decoded) continue;
      for (const h of this.endpoint.messageHandlers) h(decoded);
    }
  }

  /**
   * Phase A / A3 — turn a raw wire frame into an envelope.
   *
   * An encrypted frame is decrypted with the session cipher; a plain
   * envelope is parsed as before. A frame that arrives without a
   * cipher is **queued**, not dropped: the cipher is installed
   * asynchronously once the peer's `hello` has been verified, and a
   * frame that lands in that window is legitimate.
   */
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
        console.warn('[loopback] could not decrypt an inbound session frame:', err);
        return null;
      }
    }
    return decodeEnvelope(raw);
  }

  onMessage(handler: MessageHandler): () => void {
    this.endpoint.messageHandlers.add(handler);
    return () => {
      this.endpoint.messageHandlers.delete(handler);
    };
  }

  /**
   * Phase 16.4: the loopback transport has no notion of a remote-side
   * close. The peers are in-process and `disconnect()` is the only
   * way to tear down a loopback link. We still implement the
   * interface so `PairingSession` can call it uniformly — it just
   * never fires.
   *
   * The handler set is kept (instead of being a hardcoded no-op)
   * purely to support tests that need to simulate a peer-side
   * drop on the loopback path. Production callers can ignore
   * `onClose` — the loopback peers live in the same process and
   * never really "close" the link until one side calls
   * `disconnect()`.
   */
  private readonly closeHandlers = new Set<CloseHandler>();
  private closedByPeer = false;
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    if (this.closedByPeer) {
      queueMicrotask(() => {
        if (this.closedByPeer) {
          try {
            // The loopback path only simulates a plain peer drop —
            // there is no wire to violate a limit on.
            handler('peer-closed');
          } catch {
            // ignore — mirroring LanTransport's per-handler try/catch
          }
        }
      });
    }
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  /**
   * Phase 16.4: test-only method. Simulates a remote-side drop by
   * firing every registered `onClose` handler. Mirrors
   * `LanTransport.handlePeerClosed` in shape (idempotency,
   * best-effort cleanup). Production code does not call this —
   * the loopback transport is normally torn down via
   * `disconnect()`.
   */
  simulatePeerClose(): void {
    if (this.closedByPeer) return;
    this.closedByPeer = true;
    const handlers = Array.from(this.closeHandlers);
    for (const h of handlers) {
      try {
        h('peer-closed');
      } catch {
        // ignore — mirroring LanTransport's per-handler try/catch
      }
    }
    this.endpoint.connected = false;
  }

  async disconnect(): Promise<void> {
    this.endpoint.connected = false;
    // Local disconnect does NOT fire onClose (mirrors LanTransport).
    this.closeHandlers.clear();
    this.options.hub.unregister(this.endpoint.id);
    // Phase A / A3: tear the session key down with the link.
    this.cipher?.destroy();
    this.cipher = null;
    this.pendingFrames = [];
  }

  /** Test-only: has this endpoint been paired? */
  isConnected(): boolean {
    return this.endpoint.connected;
  }
}
