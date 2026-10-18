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
import type { CloseHandler, MessageHandler, PeerInfo, Transport } from './index';
import { LanError } from './lan-error';

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
  /** Discovery timeout (ms) used by `connect(peer)` for the joiner path. */
  private readonly discoverTimeoutMs: number;
  /**
   * Phase 16.4: close handler set + idempotency flag. The flag is
   * `true` once we've observed `Err(LanError::PeerClosed)` from the
   * Rust `lan_host_poll` / `lan_join_poll` (or after the cleanup
   * pass at end of `disconnect()`). All subsequent `onClose`
   * firings are no-ops. This satisfies the "same connection
   * reports drop only once" requirement.
   *
   * Phase 16.5: this flag is **connection-scoped, not
   * instance-scoped**. A new connection on the same transport
   * instance (startHost / startJoin / disconnect → startHost)
   * resets the flag so a fresh peer-closed event can fire onClose.
   * The previous behaviour left the flag sticky, so a peer-closed
   * event on a *new* connection was silently dropped. See Task 2.
   */
  private closeHandlers = new Set<CloseHandler>();
  private closedByPeer = false;
  /**
   * Phase 16.5: a promise that resolves once any in-flight
   * Rust-side cleanup (peer-close triggered `lan_host_stop` /
   * `lan_join_disconnect`, or an explicit `disconnect()`) has
   * completed. `startHost` / `startJoin` await this before
   * starting a new connection so a re-bind never races an
   * in-flight cleanup. The promise is single-shot: once it
   * resolves, subsequent awaits are microtask no-ops.
   *
   * Initial value is `Promise.resolve()` so the first connection
   * does not block on a non-existent cleanup.
   */
  private cleanupPromise: Promise<void> = Promise.resolve();

  constructor(opts: LanTransportOptions) {
    this.opts = opts;
    const t = getTauri();
    if (!t) {
      throw new Error(
        'LanTransport requires the Tauri runtime. Use LoopbackTransport in a browser dev context.',
      );
    }
    this.tauri = t;
    this.discoverTimeoutMs = 2500;
  }

  /**
   * Start in host mode. Returns the host info (including tcp_port).
   * The host keeps running until `disconnect()` is called.
   *
   * Phase 16.5: awaits any in-flight peer-close / disconnect
   * cleanup before issuing `lan_host_start`. Without this, a new
   * host_start could race the in-flight host_stop on the Rust
   * side and either hit `AlreadyRunning` (if the old host is
   * still in the state) or bind a fresh listener on top of a
   * half-torn-down one.
   */
  async startHost(code: string): Promise<LanHostInfo> {
    if (this.mode !== 'idle') {
      throw new Error(`LanTransport already in mode '${this.mode}'`);
    }
    await this.awaitCleanup();
    const info = await this.tauri.invoke<LanHostInfo>('lan_host_start', {
      code,
      agentId: this.opts.selfAgentId,
      displayName: this.opts.selfDisplayName,
    });
    this.mode = 'host';
    // Phase 16.5: reset the peer-closed flag and handler set on
    // every fresh connection. See Task 2 — a previous connection's
    // `closedByPeer = true` must not silence onClose for this one.
    this.closedByPeer = false;
    this.closeHandlers.clear();
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
   *
   * Phase 16.5: same cleanup-promise guarantee as `startHost`.
   */
  async startJoin(peer: LanJoinPeer): Promise<void> {
    if (this.mode !== 'idle') {
      throw new Error(`LanTransport already in mode '${this.mode}'`);
    }
    await this.awaitCleanup();
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
    // Phase 16.5: reset the peer-closed flag and handler set on
    // every fresh connection.
    this.closedByPeer = false;
    this.closeHandlers.clear();
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

  /**
   * Transport.connect — satisfies the `Transport` interface.
   *
   *   - host mode:  no-op. The host already bound via `startHost(code)`
   *                 and is listening for the joiner; `connect()` here
   *                 just records the self-peer info on our side. The
   *                 session's `startHost(transport)` calls this and
   *                 then transitions to 'hosting' state.
   *   - join mode:  no-op. The joiner dialed via `startJoin(peer)` and
   *                 `connect()` is a confirmation. The session's
   *                 `startJoin(transport, code)` calls this and
   *                 transitions to 'joining'/'connected'.
   *   - idle mode:  joiner path. The pairing code lives in `peer.hint`
   *                 (per the Transport contract). We do UDP discovery
   *                 filtered by code, then dial the first matching peer.
   *                 Throws if the discovery times out.
   *
   * Note: when called from a PairingSession that was *already*
   * configured via the dedicated `startHost`/`startJoin` methods on
   * this transport, `connect()` is a no-op — the dedicated methods
   * already started the actual network setup. This mirrors the
   * loopback path where `connect(peerInfo)` is the single entry point
   * and the LAN path where the dedicated methods pre-stage.
   */
  async connect(peer: PeerInfo): Promise<void> {
    if (this.mode === 'host' || this.mode === 'join') {
      // Already started via the dedicated methods. No-op.
      return;
    }
    if (this.mode === 'idle') {
      const code = peer.hint;
      if (!code) {
        throw new Error(
          'LanTransport.connect: a joiner needs peer.hint set to the pairing code. Call startJoin(peer) directly with a discovered peer instead.',
        );
      }
      const peers = await this.discover(code, this.discoverTimeoutMs);
      if (peers.length === 0) {
        throw new Error(
          `LanTransport.connect: no peer on the LAN responded to code "${code}" within ${this.discoverTimeoutMs}ms.`,
        );
      }
      await this.startJoin(peers[0]!);
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

  /**
   * Phase 16.4: peer-close event hook. The handler fires ONCE per
   * transport instance when the Rust side reports
   * `Err(LanError::PeerClosed)` from a poll call. It does NOT fire
   * for local `disconnect()` calls — those clear the close
   * handlers via the explicit teardown path.
   *
   * `PairingSession` registers a handler that transitions the FSM
   * to `'closed'` with `closeReason = 'peer-closed'`, so an
   * in-flight `MatchOrchestrator` short-circuits its hello wait
   * with `HandshakeClosedError` instead of `HandshakeTimeoutError`.
   */
  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    // If the close event already fired (e.g. the handler is
    // registered after the wire drop), invoke it on the next
    // microtask so the caller's bookkeeping still runs. This is
    // safer than calling it synchronously inside `onClose` because
    // the caller's `onClose` call may not have set up its own state
    // yet.
    if (this.closedByPeer) {
      queueMicrotask(() => {
        if (this.closedByPeer) {
          try {
            handler();
          } catch (e) {
            // Don't let one late subscriber crash the dispatch.
            console.warn('[lan] onClose handler threw:', e);
          }
        }
      });
    }
    return () => {
      this.closeHandlers.delete(handler);
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.closedByPeer) {
      // Phase 16.5: cleanup was already scheduled by
      // `handlePeerClosed` — await the same promise. We must NOT
      // re-dispatch a second `lan_host_stop` / `lan_join_disconnect`
      // because the Rust side has already accepted the first
      // (the second would also be idempotent there, but it
      // re-introduces the race we are trying to eliminate).
      await this.cleanupPromise;
    } else {
      // Phase 16.5: capture the mode at the time of the call
      // because `runRustCleanup` reads it synchronously, but
      // `this.mode` may be reset later in this method.
      const cleanupMode = this.mode;
      this.cleanupPromise = this.runRustCleanup(cleanupMode);
      await this.cleanupPromise;
    }
    this.mode = 'idle';
    this.peer = null;
    // Phase 16.5: reset the peer-closed flag and handler set on
    // every teardown so a fresh connection on this same instance
    // starts clean. See Task 2.
    this.closedByPeer = false;
    this.closeHandlers.clear();
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

  /**
   * Phase 16.5: schedule the Rust-side cleanup for the current
   * connection. Always returns a promise that resolves (never
   * rejects) so callers can safely await without try/catch.
   * Failures are logged at debug — they do not surface to the
   * caller because the next `host_start` / `join_connect` will
   * report the real state (e.g. `AlreadyRunning` if the cleanup
   * truly failed on the Rust side).
   *
   * The `atMode` argument captures the connection role at the
   * time of the call. The caller MUST snapshot the mode because
   * `this.mode` may be reset to `'idle'` synchronously by the
   * peer-close path before this method runs.
   */
  private runRustCleanup(atMode: Mode): Promise<void> {
    if (atMode === 'host') {
      return this.tauri
        .invoke('lan_host_stop')
        .catch((e: unknown) => {
          console.debug('[lan] host_stop failed during cleanup:', e);
        })
        .then(() => undefined);
    }
    if (atMode === 'join') {
      return this.tauri
        .invoke('lan_join_disconnect')
        .catch((e: unknown) => {
          console.debug('[lan] join_disconnect failed during cleanup:', e);
        })
        .then(() => undefined);
    }
    return Promise.resolve();
  }

  /**
   * Phase 16.5: wait for any in-flight Rust-side cleanup to
   * complete. Called by `startHost` / `startJoin` so a re-bind
   * never races the in-flight `host_stop` / `join_disconnect`
   * of the previous connection. Safe to call when no cleanup is
   * in flight — the initial `cleanupPromise` is `Promise.resolve()`.
   */
  private async awaitCleanup(): Promise<void> {
    await this.cleanupPromise;
  }

  /**
   * Phase 16.4: dispatch the peer-close event. Idempotent. Sets
   * `closedByPeer` first so any re-entry (e.g. a handler calling
   * `disconnect()` synchronously) doesn't double-fire. Stops the
   * poll loop, fires every registered close handler (each in a
   * try/catch — one bad handler must not silence the rest), then
   * best-effort cleans up the Rust-side state (`lan_host_stop` /
   * `lan_join_disconnect`) and forces our local state to
   * 'idle'.
   *
   * The order matters: handlers are fired BEFORE the Rust cleanup
   * so a handler that synchronously reads `lan_host_status` (or
   * similar) still sees a coherent state. The Rust cleanup is
   * tracked in `cleanupPromise` so a subsequent `startHost` /
   * `startJoin` / `disconnect` can await it instead of racing
   * the in-flight IPC. See Task 1.
   */
  private handlePeerClosed(): void {
    if (this.closedByPeer) return;
    this.closedByPeer = true;
    this.stopPolling();
    // Snapshot the handler set so a handler that registers a new
    // handler doesn't get a recursive call.
    const handlers = Array.from(this.closeHandlers);
    for (const h of handlers) {
      try {
        h();
      } catch (e) {
        // Don't let one bad handler silence the rest.
        console.warn('[lan] onClose handler threw:', e);
      }
    }
    // Phase 16.5: capture the mode at the time of the close so
    // the cleanup runs the right command even after we reset
    // `this.mode` synchronously below. Without this, an immediate
    // `disconnect()` (driven by the close handler) would observe
    // `mode === 'idle'` and skip the actual `lan_host_stop`,
    // leaving the Rust state half-torn-down.
    const cleanupMode = this.mode;
    this.mode = 'idle';
    this.peer = null;
    // Phase 16.5: track the cleanup promise. `startHost` /
    // `startJoin` / `disconnect` await this so a re-bind never
    // races the in-flight cleanup. Best-effort — failures are
    // logged at debug, not propagated. The next `host_start` /
    // `join_connect` will surface the actual Rust state via its
    // own error if the cleanup truly left the Rust side in a
    // bad place (e.g. `AlreadyRunning`).
    this.cleanupPromise = this.runRustCleanup(cleanupMode);
  }

  private async pollOnce(): Promise<void> {
    // Phase 16.4: if a prior tick already detected the close, do
    // not run another poll. The Rust side's `host_poll` will
    // continue to return `Err(PeerClosed)` until the cleanup
    // happens, and a second `handlePeerClosed` is a no-op thanks
    // to the `closedByPeer` flag, but skipping the IPC call
    // entirely keeps the polling cost at zero after a peer drop.
    if (this.closedByPeer) return;
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
      // Phase 16.4: classify the rejection. `Err(LanError::
      // PeerClosed)` is the explicit "remote end dropped the TCP
      // link" signal — fire `onClose` and stop polling. Other
      // errors (NotConnected, Io, Tauri runtime failure) are
      // transient or local; we log at debug and let the next tick
      // retry. This is the same retry behaviour as before — only
      // the peer-close path is new.
      const lanErr = LanError.from(err);
      if (lanErr.isPeerClosed()) {
        this.handlePeerClosed();
        return;
      }
      // Don't let one bad poll kill the rest.
      console.debug('[lan] poll error:', err);
    }
  }
}
