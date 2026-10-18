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
import { decodeEnvelope, encodeEnvelope, type KsaMessage } from '@kindora/protocol';
import type { CloseHandler, MessageHandler, PeerInfo, Transport } from './index';

interface Endpoint {
  readonly id: string;
  readonly messageHandlers: Set<MessageHandler>;
  connected: boolean;
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
    const ep: Endpoint = { id, messageHandlers: new Set(), connected: false };
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

  /** Deliver a serialised envelope from one endpoint to its paired peer. */
  deliver(fromId: string, rawJson: string): boolean {
    const from = this.endpoints.get(fromId);
    if (!from || !from.connected) return false;
    // The hub does not know the peer id — broadcast to every other
    // connected endpoint. (For the V0.1 use case, a hub has at most
    // two connected endpoints.)
    const decoded = decodeEnvelope(rawJson) as KsaMessage;
    for (const [id, ep] of this.endpoints) {
      if (id === fromId) continue;
      if (!ep.connected) continue;
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

  constructor(private readonly options: LoopbackTransportOptions) {
    this.endpoint = options.hub.register(options.endpointId);
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
    const ok = this.options.hub.deliver(this.endpoint.id, encodeEnvelope(message));
    if (!ok) {
      throw new Error('LoopbackTransport: no peer to deliver to.');
    }
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
            handler();
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
        h();
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
  }

  /** Test-only: has this endpoint been paired? */
  isConnected(): boolean {
    return this.endpoint.connected;
  }
}
