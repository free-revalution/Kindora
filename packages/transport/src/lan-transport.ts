/**
 * LanTransport — Tauri 2 frontend transport implementation.
 *
 * Wraps the Rust-side `lan_*` Tauri commands to expose the same
 * `Transport` interface as `LoopbackTransport`. Two roles:
 *
 *   - host:   binds a TCP listener and a UDP discovery responder on
 *             the local LAN. Once a joiner connects, both sides
 *             exchange JSON envelopes.
 *   - joiner: broadcasts a UDP discover datagram, picks a host from
 *             the announce list, opens a TCP connection.
 *
 * The Transport contract is identical to LoopbackTransport so that
 * `PairingSession`, `MatchOrchestrator`, etc. work without change.
 *
 * V0.1 limitations:
 *   - Discovery is broadcast on 255.255.255.255:52419 — works on most
 *     home / office LANs; does NOT cross subnets / VLANs / AP
 *     isolation. The UI surfaces this as a non-fatal warning.
 *   - Single peer per session (host accepts one connection and
 *     stops listening). Documented.
 *   - No TCP-level encryption. The KSA envelope layer above this
 *     transport is the trust boundary. Suitable for prototype;
 *     production must add TLS or a WebRTC DataChannel layer.
 *
 *   See 开发手册.md § 18 Mode A, § 19.
 */

import type { KsaMessage } from '@kindora/protocol';
import { decodeEnvelope, encodeEnvelope } from '@kindora/protocol';
import type { MessageHandler, PeerInfo, Transport } from './index';

/** Tauri 2 `invoke` and `event` shim. Falls back to throwing if not in Tauri runtime. */
interface TauriRuntime {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

function getTauri(): TauriRuntime | null {
  const w = (typeof window !== 'undefined' ? window : (globalThis as { window?: Window }).window) as
    | (Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } })
    | undefined;
  if (!w) return null;
  const inv = w.__TAURI_INTERNALS__?.invoke;
  if (typeof inv !== 'function') return null;
  return {
    invoke: <T>(cmd: string, args?: Record<string, unknown>) => inv.call(w.__TAURI_INTERNALS__, cmd, args) as Promise<T>,
  };
}

export interface LanTransportOptions {
  /** Self agent id — sent to peer in `hello`. */
  readonly selfAgentId: string;
  /** Self display name — sent to peer in `hello`. */
  readonly selfDisplayName: string;
}

export interface LanHostInfo {
  readonly tcp_port: number;
  readonly agent_id: string;
  readonly display_name: string;
  readonly code: string;
}

export interface LanJoinPeer {
  readonly ip: string;
  readonly port: number;
  readonly agent_id: string;
  readonly display_name: string;
  readonly code: string;
}

type Mode = 'idle' | 'host' | 'join';

/**
 * LanTransport — implements `Transport` over the Tauri LAN commands.
 *
 * Use as:
 *
 *   const t = new LanTransport({ selfAgentId, selfDisplayName });
 *   await t.startHost('ABC123');
 *   // wait for peer to connect; transport transitions to 'connected'
 *   const peer = await t.connectedPeer();
 *   await t.send(envelope);
 *   t.onMessage((env) => { ... });
 *   await t.disconnect();
 *
 * Or, as a joiner:
 *
 *   const t = new LanTransport({ selfAgentId, selfDisplayName });
 *   const peers = await t.discover('ABC123', 2500);
 *   await t.startJoin(peers[0]);
 *   await t.send(envelope);
 */
export class LanTransport implements Transport {
  private readonly opts: LanTransportOptions;
  private readonly tauri: TauriRuntime;
  private mode: Mode = 'idle';
  private handlers = new Set<MessageHandler>();
  /** Cached peer info once connected (host: when joiner connects; join: after connect). */
  private peer: PeerInfo | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LanTransportOptions) {
    this.opts = opts;
    const t = getTauri();
    if (!t) {
      throw new Error(
        'LanTransport requires the Tauri runtime. Use LoopbackTransport in a browser dev context.',
      );
    }
    this.tauri = t;
  }

  /**
   * Start in host mode. Returns the host info (including tcp_port).
   * The host keeps running until `disconnect()` is called.
   */
  async startHost(code: string): Promise<LanHostInfo> {
    if (this.mode !== 'idle') {
      throw new Error(`LanTransport already in mode '${this.mode}'`);
    }
    const info = await this.tauri.invoke<LanHostInfo>('lan_host_start', {
      code,
      agentId: this.opts.selfAgentId,
      displayName: this.opts.selfDisplayName,
    });
    this.mode = 'host';
    this.startPolling();
    return info;
  }

  /**
   * Discover peers on the LAN that match `code`. Returns up to N peers
   * that responded within `timeoutMs` to the broadcast discover.
   */
  async discover(code: string, timeoutMs: number = 2500): Promise<readonly LanJoinPeer[]> {
    return this.tauri.invoke<readonly LanJoinPeer[]>('lan_join_discover', {
      code,
      timeoutMs,
    });
  }

  /**
   * Start in joiner mode by connecting to a discovered peer.
   */
  async startJoin(peer: LanJoinPeer): Promise<void> {
    if (this.mode !== 'idle') {
      throw new Error(`LanTransport already in mode '${this.mode}'`);
    }
    const info = await this.tauri.invoke<LanJoinPeer>('lan_join_connect', {
      peerIp: peer.ip,
      peerPort: peer.port,
    });
    this.peer = {
      agentId: info.agent_id || peer.agent_id,
      displayName: info.display_name || peer.display_name,
      hint: `${peer.ip}:${peer.port}`,
    };
    this.mode = 'join';
    this.startPolling();
  }

  /** True once a peer is connected (host: a joiner arrived; join: connect succeeded). */
  isConnected(): boolean {
    return this.peer !== null;
  }

  /** Return the connected peer info, or null. */
  connectedPeer(): PeerInfo | null {
    return this.peer;
  }

  /**
   * Current host info (host mode only) or null. Useful for the UI to
   * display "your code: ABC123".
   */
  async hostInfo(): Promise<LanHostInfo | null> {
    if (this.mode !== 'host') return null;
    return this.tauri.invoke<LanHostInfo | null>('lan_host_status');
  }

  /** True once the host's first peer has connected. */
  async hostLinked(): Promise<boolean> {
    if (this.mode !== 'host') return false;
    return this.tauri.invoke<boolean>('lan_host_linked');
  }

  // ---------- Transport interface ----------

  async connect(_peer: PeerInfo): Promise<void> {
    // The LanTransport is self-managing: call startHost / startJoin instead.
    // We keep this method to satisfy the Transport interface but it
    // should be a no-op when already started.
    if (this.mode === 'idle') {
      throw new Error(
        'LanTransport.connect: use startHost(code) or startJoin(peer) — the Transport.connect interface is not the right entry point for LAN.',
      );
    }
  }

  async send(message: KsaMessage): Promise<void> {
    if (this.mode === 'idle') {
      throw new Error('LanTransport.send: not started');
    }
    const encoded = encodeEnvelope(message);
    if (this.mode === 'host') {
      await this.tauri.invoke('lan_host_send', { message: encoded });
    } else {
      await this.tauri.invoke('lan_join_send', { message: encoded });
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.mode === 'host') {
      try {
        await this.tauri.invoke('lan_host_stop');
      } catch {
        // ignore
      }
    } else if (this.mode === 'join') {
      try {
        await this.tauri.invoke('lan_join_disconnect');
      } catch {
        // ignore
      }
    }
    this.mode = 'idle';
    this.peer = null;
  }

  // ---------- internals ----------

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, 200);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    try {
      const messages =
        this.mode === 'host'
          ? await this.tauri.invoke<readonly string[]>('lan_host_poll')
          : await this.tauri.invoke<readonly string[]>('lan_join_poll');
      if (this.mode === 'host' && !this.peer) {
        // Try to detect when a peer has connected (host only).
        const linked = await this.hostLinked();
        if (linked) {
          // The host's PeerInfo is the connecting joiner. We don't have
          // their agent id until they send a hello envelope. Default
          // to a placeholder.
          this.peer = { agentId: 'pending', displayName: 'pending' };
        }
      }
      for (const raw of messages) {
        const env = decodeEnvelope(raw);
        if (!env) continue;
        for (const h of this.handlers) {
          try {
            h(env);
          } catch (err) {
            // Don't let one handler kill the rest.
            console.warn('[lan] message handler threw:', err);
          }
        }
        // If we receive a hello envelope, update the peer info.
        // The agent id is in the envelope's `sender` field, not in the
        // hello payload (the payload only carries displayName).
        if (env.type === 'hello' && this.peer) {
          const payload = env.payload as { displayName?: string };
          this.peer = {
            agentId: env.sender ?? this.peer.agentId,
            displayName: payload.displayName ?? this.peer.displayName,
            hint: this.peer.hint,
          };
        }
      }
    } catch (err) {
      // Swallow poll errors — the next tick will retry.
      console.debug('[lan] poll error:', err);
    }
  }
}
