/**
 * Vitest tests for the LanTransport class — the JS shim that wraps the
 * Tauri `lan_*` commands.
 *
 * Strategy: stub the Tauri runtime in `window.__TAURI_INTERNALS__` and
 * drive the LanTransport through a mock backend that simulates:
 *   - UDP discover / announce
 *   - TCP connect + frame read/write
 *
 * The mock backend is intentionally minimal — we exercise the
 * LanTransport's public surface (state machine, message handling,
 * peer detection) without touching the real network. Real network
 * behaviour is covered by the Rust cross-process binary tests in
 * apps/desktop/src-tauri/scripts/run_unicast_test.sh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LanTransport } from '../lan-transport';
import { decodeEnvelope, encodeEnvelope, type KsaMessage } from '@kindora/protocol';

interface MockLink {
  /** Buffered messages to deliver to the LanTransport's onMessage handlers. */
  inbound: string[];
  /** Outbound messages sent by the LanTransport. */
  outbound: string[];
  connected: boolean;
  peerAgentId?: string;
  peerDisplayName?: string;
}

interface MockState {
  hostLink: MockLink | null;
  joinLink: MockLink | null;
  hostStarted: boolean;
  joinStarted: boolean;
  discoverResults: Array<{ ip: string; port: number; agent_id: string; display_name: string; code: string }>;
  /**
   * Phase 16.4: control whether the next `lan_host_poll` /
   * `lan_join_poll` invocation throws `peer closed`. Once set, the
   * mock switches the relevant poll into a permanently-peer-closed
   * mode (every subsequent call also throws), so the test exercises
   * both the first observation and any retry / second-poll edge
   * cases.
   */
  hostPollPeerClosed: boolean;
  joinPollPeerClosed: boolean;
  /**
   * Phase 16.5: optional delay (ms) before `lan_host_stop`
   * resolves. Used to test that `startHost` waits for the
   * in-flight cleanup before issuing `lan_host_start`.
   */
  hostStopDelayMs: number;
  /** Optional delay (ms) before `lan_join_disconnect` resolves. */
  joinDisconnectDelayMs: number;
  /**
   * If non-null, `lan_host_stop` rejects with this error message.
   * Used to test the cleanup-failure path.
   */
  hostStopFails: string | null;
  /** If non-null, `lan_join_disconnect` rejects with this error. */
  joinDisconnectFails: string | null;
  /**
   * Phase 16.5: ordered list of every IPC command the mock has
   * received so far. Lets tests assert call ordering (e.g.
   * `host_stop` MUST complete before the next `host_start`).
   */
  callLog: string[];
}

function makeKsaHello(agentId: string, displayName: string): KsaMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    timestamp: new Date().toISOString(),
    type: 'hello',
    sender: '00000000-0000-4000-8000-000000000001',
    payload: {
      agentId,
      displayName,
      capabilities: {
        protocolVersion: '0.1',
        supportsMatchAnalysis: true,
        supportsIcebreaker: true,
        supportsChatAssist: true,
        supportsEncryption: false,
      },
      status: 'available',
    },
  } as unknown as KsaMessage;
}

function installTauriMock(state: MockState) {
  const w = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  w.__TAURI_INTERNALS__ = {
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      state.callLog.push(cmd);
      switch (cmd) {
        case 'lan_host_start':
          state.hostStarted = true;
          return { tcp_port: 52420, agent_id: args?.agentId, display_name: args?.displayName, code: args?.code };
        case 'lan_host_status':
          return state.hostStarted
            ? { tcp_port: 52420, agent_id: 'self', display_name: 'self', code: 'ABC123' }
            : null;
        case 'lan_host_linked':
          return Boolean(state.hostLink?.connected);
        case 'lan_host_poll': {
          if (state.hostPollPeerClosed) throw new Error('peer closed');
          const link = state.hostLink;
          if (!link) return [];
          const drained = link.inbound.splice(0, link.inbound.length);
          return drained;
        }
        case 'lan_host_send': {
          const link = state.hostLink;
          if (!link) throw new Error('not connected');
          link.outbound.push(String(args?.message ?? ''));
          return null;
        }
        case 'lan_host_stop': {
          if (state.hostStopDelayMs > 0) {
            await new Promise((r) => setTimeout(r, state.hostStopDelayMs));
          }
          if (state.hostStopFails) {
            throw new Error(state.hostStopFails);
          }
          state.hostStarted = false;
          state.hostLink = null;
          return null;
        }
        case 'lan_join_discover':
          return state.discoverResults;
        case 'lan_join_connect': {
          state.joinStarted = true;
          const link: MockLink = { inbound: [], outbound: [], connected: true };
          state.joinLink = link;
          return {
            ip: args?.peerIp,
            port: args?.peerPort,
            agent_id: 'peer-agent',
            display_name: 'Peer',
            code: '',
          };
        }
        case 'lan_join_poll': {
          if (state.joinPollPeerClosed) throw new Error('peer closed');
          const link = state.joinLink;
          if (!link) return [];
          return link.inbound.splice(0, link.inbound.length);
        }
        case 'lan_join_send': {
          const link = state.joinLink;
          if (!link) throw new Error('not connected');
          link.outbound.push(String(args?.message ?? ''));
          return null;
        }
        case 'lan_join_disconnect': {
          if (state.joinDisconnectDelayMs > 0) {
            await new Promise((r) => setTimeout(r, state.joinDisconnectDelayMs));
          }
          if (state.joinDisconnectFails) {
            throw new Error(state.joinDisconnectFails);
          }
          state.joinStarted = false;
          state.joinLink = null;
          return null;
        }
        default:
          throw new Error(`unknown mock command: ${cmd}`);
      }
    },
  };
}

describe('LanTransport (Tauri shim)', () => {
  let state: MockState;
  beforeEach(() => {
    state = {
      hostLink: null,
      joinLink: null,
      hostStarted: false,
      joinStarted: false,
      discoverResults: [],
      hostPollPeerClosed: false,
      joinPollPeerClosed: false,
      hostStopDelayMs: 0,
      joinDisconnectDelayMs: 0,
      hostStopFails: null,
      joinDisconnectFails: null,
      callLog: [],
    };
    installTauriMock(state);
  });

  afterEach(async () => {
    // disconnect any in-flight transport by running the tauri mock reset
    if (state.hostStarted) await new LanTransport({ selfAgentId: 'self', selfDisplayName: 'self' }).startHost('ZZZZZZ').catch(() => undefined);
  });

  it('throws in non-Tauri runtime', () => {
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    delete w.__TAURI_INTERNALS__;
    expect(() => new LanTransport({ selfAgentId: 'self', selfDisplayName: 'self' })).toThrow();
    installTauriMock(state); // restore for next test
  });

  it('hostStart returns the host info and polls empty initially', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    const info = await t.startHost('ABC123');
    expect(info.tcp_port).toBe(52420);
    expect(info.code).toBe('ABC123');
    expect(t.isConnected()).toBe(false);
    await t.disconnect();
  });

  it('hostStart twice throws', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    await expect(t.startHost('DEF456')).rejects.toThrow(/already in mode/);
    await t.disconnect();
  });

  it('discover returns the mock peer list', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    const peers = await t.discover('ABC123', 1000);
    expect(peers.length).toBe(1);
    expect(peers[0]?.ip).toBe('192.168.1.10');
  });

  it('joiner sends and receives envelopes', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    expect(t.isConnected()).toBe(true);

    // Send a hello.
    const hello = makeKsaHello('self', 'Self');
    await t.send(hello);
    // Allow poll to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(state.joinLink?.outbound.length).toBe(1);
    expect(state.joinLink?.outbound[0]).toBe(encodeEnvelope(hello));

    // Receive a hello from the peer.
    const peerHello = makeKsaHello('peer', 'Peer');
    state.joinLink?.inbound.push(encodeEnvelope(peerHello));
    const received: KsaMessage[] = [];
    t.onMessage((m) => received.push(m));
    await new Promise((r) => setTimeout(r, 250));
    expect(received.length).toBeGreaterThanOrEqual(1);
    const env = decodeEnvelope(state.joinLink?.outbound[0] ?? '');
    expect(env?.type).toBe('hello');

    await t.disconnect();
  });

  it('host detects peer connection and updates peer info from hello', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    expect(t.isConnected()).toBe(false);

    // Inbound hello from the peer FIRST — the host's poll loop will
    // pick it up and set the peer info from the hello.
    const peerHello = makeKsaHello('peer-uuid', 'Peer Name');
    state.hostLink = { inbound: [encodeEnvelope(peerHello)], outbound: [], connected: true };
    const got: KsaMessage[] = [];
    t.onMessage((m) => got.push(m));
    // Give the poll loop two ticks (poll interval is 200ms).
    await new Promise((r) => setTimeout(r, 500));
    expect(t.isConnected()).toBe(true);
    expect(got.length).toBe(1);
    expect(t.connectedPeer()?.agentId).toBe('00000000-0000-4000-8000-000000000001');
    expect(t.connectedPeer()?.displayName).toBe('Peer Name');

    // Send a message.
    await t.send(makeKsaHello('self', 'Self'));
    await new Promise((r) => setTimeout(r, 50));
    expect(state.hostLink?.outbound.length).toBe(1);

    await t.disconnect();
  });

  it('disconnect tears down host and join state', async () => {
    const t1 = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t1.startHost('ABC123');
    await t1.disconnect();
    expect(state.hostStarted).toBe(false);

    const t2 = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t2.startJoin(state.discoverResults[0]!);
    await t2.disconnect();
    expect(state.joinStarted).toBe(false);
  });

  it('send before start throws', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await expect(t.send(makeKsaHello('self', 'Self'))).rejects.toThrow(/not started/);
  });

  it('message handler errors do not break the loop', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    t.onMessage(() => {
      throw new Error('boom');
    });
    const received: KsaMessage[] = [];
    t.onMessage((m) => received.push(m));
    state.joinLink?.inbound.push(encodeEnvelope(makeKsaHello('peer', 'Peer')));
    state.joinLink?.inbound.push(encodeEnvelope(makeKsaHello('peer', 'Peer 2')));
    await new Promise((r) => setTimeout(r, 250));
    expect(received.length).toBe(2);
    await t.disconnect();
  });

  it('onMessage returns an unsubscribe function', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    const got: KsaMessage[] = [];
    const unsub = t.onMessage((m) => got.push(m));
    state.joinLink?.inbound.push(encodeEnvelope(makeKsaHello('peer', 'Peer')));
    await new Promise((r) => setTimeout(r, 250));
    expect(got.length).toBe(1);
    unsub();
    state.joinLink?.inbound.push(encodeEnvelope(makeKsaHello('peer', 'Peer 2')));
    await new Promise((r) => setTimeout(r, 250));
    expect(got.length).toBe(1);
    await t.disconnect();
  });

  // ---- Transport.connect() interface ----

  it('connect() in idle mode with peer.hint discovers + dials the first peer', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    // Connect via the Transport interface using a PeerInfo whose hint
    // is the pairing code. The LanTransport should discover by code
    // and dial the first match.
    await t.connect({ agentId: 'peer', displayName: 'Peer', hint: 'ABC123' });
    expect(t.isConnected()).toBe(true);
    expect(t.connectedPeer()?.hint).toBe('192.168.1.10:52420');
    await t.disconnect();
  });

  it('connect() in idle mode throws when no peer is found', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [];
    await expect(
      t.connect({ agentId: 'peer', displayName: 'Peer', hint: 'NOSUCH' }),
    ).rejects.toThrow(/no peer on the LAN/i);
  });

  it('connect() in idle mode throws when peer.hint is missing', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await expect(
      // hint is required for the joiner auto-discover path.
      t.connect({ agentId: 'peer', displayName: 'Peer' }),
    ).rejects.toThrow(/pairing code/i);
  });

  it('connect() in host mode is a no-op', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    // After startHost, the transport is in 'host' mode. connect()
    // must NOT throw and must NOT re-bind.
    await t.connect({ agentId: 'peer', displayName: 'Peer', hint: 'ABC123' });
    expect(t.isConnected()).toBe(false); // still no peer arrived
    await t.disconnect();
  });

  it('connect() in join mode is a no-op (already connected)', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    // startJoin moves to 'join' mode and connects. A second connect()
    // must NOT re-discover or throw.
    await t.connect({ agentId: 'peer', displayName: 'Peer', hint: 'ABC123' });
    expect(t.isConnected()).toBe(true);
    await t.disconnect();
  });

  // ---- Phase 16.4: peer-close propagation (onClose hook) ----

  it('host: peer-closed from lan_host_poll fires onClose exactly once', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    // The mock's hostLink starts as null — give the host a peer so
    // the next poll is meaningful. (hostPollPeerClosed is checked
    // before hostLink, but a no-link peer would still be a real
    // scenario; the important thing here is that the IPC throws.)
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    let fired = 0;
    t.onClose(() => {
      fired += 1;
    });
    // Poll interval is 200ms. Wait long enough for at least one tick
    // and short enough to keep the test snappy.
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    // Subsequent ticks do not re-fire.
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    // A second `onClose` registered after the event fires once on
    // the next microtask (the late-subscriber contract).
    let lateFired = 0;
    t.onClose(() => {
      lateFired += 1;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(lateFired).toBe(1);
    await t.disconnect();
  });

  it('joiner: peer-closed from lan_join_poll fires onClose exactly once', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    state.joinPollPeerClosed = true;
    let fired = 0;
    t.onClose(() => {
      fired += 1;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    await t.disconnect();
  });

  it('local disconnect does NOT fire onClose (only peer-side drops do)', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    let fired = 0;
    t.onClose(() => {
      fired += 1;
    });
    await t.disconnect();
    // Give a couple of poll cycles a chance to run; none should
    // observe a peer-closed because the mock's hostPollPeerClosed
    // is still false.
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(0);
  });

  it('onClose handler is unsubscribed correctly', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    let fired = 0;
    const unsub = t.onClose(() => {
      fired += 1;
    });
    unsub();
    state.hostPollPeerClosed = true;
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(0);
    await t.disconnect();
  });

  it('onClose handler that throws does not block the dispatch', async () => {
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    let secondFired = 0;
    // Suppress the expected warn log for this test.
    const origWarn = console.warn;
    console.warn = () => undefined;
    try {
      t.onClose(() => {
        throw new Error('boom');
      });
      t.onClose(() => {
        secondFired += 1;
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(secondFired).toBe(1);
    } finally {
      console.warn = origWarn;
    }
    await t.disconnect();
  });

  it('after peer-closed, a fresh LanTransport can start a new host on the same LanState', async () => {
    // First host: runs, peer-closes, transport tears down.
    const t1 = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t1.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    let fired = 0;
    t1.onClose(() => {
      fired += 1;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    await t1.disconnect();

    // Reset the mock so the second host can run cleanly.
    state.hostLink = null;
    state.hostStarted = false;
    state.hostPollPeerClosed = false;
    const t2 = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t2.startHost('DEF456');
    expect(t2.isConnected()).toBe(false);
    await t2.disconnect();
  });

  // ---- Phase 16.5 § Task 1: cleanup-promise tracking ----

  it('Task 1: startHost waits for the in-flight peer-close cleanup to complete', async () => {
    // The mock's `lan_host_stop` takes 300 ms (configured below).
    // The first connection's peer-close triggers handlePeerClosed,
    // which dispatches `lan_host_stop` (still pending) and sets
    // `cleanupPromise` to that pending promise. A subsequent
    // startHost MUST await `cleanupPromise` before issuing
    // `lan_host_start` — otherwise the new host_start would race
    // the old host_stop on the Rust side and either hit
    // `AlreadyRunning` or bind a listener on top of a half-torn-
    // down one.
    //
    // Synchronization strategy: we wait until the mock's callLog
    // contains `lan_host_stop` (meaning the IPC was DISPATCHED but
    // not yet resolved, because the mock delays resolution by
    // 300 ms). This is not a "delay to mask the race" — it is a
    // synchronization point on observable state. Once we see
    // `lan_host_stop` in the log, we know the in-flight cleanup is
    // genuinely pending, and the timing assertion below is
    // measuring real wait time, not a slack upper bound.
    state.hostStopDelayMs = 300;
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);

    // Wait until the cleanup IPC is dispatched.
    while (!state.callLog.includes('lan_host_stop')) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // Sanity: the cleanup is genuinely in flight (delay 300 ms).
    expect(state.hostStopDelayMs).toBe(300);
    // Clear the log so the post-reset assertion only sees the
    // new host's IPC traffic.
    state.callLog = [];

    const start = Date.now();
    await t.startHost('DEF456');
    const elapsed = Date.now() - start;
    // The new startHost must have blocked for roughly the
    // remaining host_stop time. Lower bound: 250 ms (90 % of the
    // 300 ms delay, to stay resilient to microtask jitter).
    expect(elapsed).toBeGreaterThanOrEqual(250);
    // IPC ordering: only the new host_start should be in the log
    // — no other IPC happened during the wait.
    expect(state.callLog).toEqual(['lan_host_start']);

    await t.disconnect();
  });

  it('Task 1: startHost immediately after peer-closed succeeds (no AlreadyRunning)', async () => {
    // Even with a synchronous (no-delay) cleanup, the second
    // startHost on the same instance MUST succeed because
    // awaitCleanup blocks until the in-flight host_stop resolves
    // before the host_start is issued. Without the await, the
    // second host_start would race the first host_stop on the
    // Rust side.
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);
    await new Promise((r) => setTimeout(r, 500));

    // The transport is in 'idle' mode (set by handlePeerClosed).
    // A fresh startHost should succeed.
    state.hostLink = null;
    state.hostPollPeerClosed = false;
    const info = await t.startHost('DEF456');
    expect(info.code).toBe('DEF456');
    expect(state.hostStarted).toBe(true);
    await t.disconnect();
  });

  it('Task 1: a single peer-closed event triggers exactly one host_stop IPC', async () => {
    // Q2: "同一连接是否可能同时触发多个清理任务？"
    // The `closedByPeer` guard is idempotent, but verify it on the
    // IPC level: only ONE `lan_host_stop` should be issued even
    // though the mock keeps throwing 'peer closed' on every poll.
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);
    // Wait long enough for many poll ticks (poll interval is
    // 200 ms; wait 1 s = 5+ ticks).
    await new Promise((r) => setTimeout(r, 1000));
    const stopCount = state.callLog.filter((c) => c === 'lan_host_stop').length;
    expect(stopCount).toBe(1);
    await t.disconnect();
  });

  it('Task 1: cleanup failure does not block subsequent startHost', async () => {
    // Q3: "清理失败时，transport 是否会错误地宣称已完全恢复？"
    // The transport's `runRustCleanup` swallows the error and
    // resolves the promise. The transport does NOT silently
    // succeed — the next startHost will surface the real Rust
    // state. In the mock, the host_stop rejects, but the
    // subsequent host_start still completes (because the mock
    // doesn't actually model the Rust lock). The contract: the
    // transport does not throw spuriously, and the next operation
    // either succeeds or surfaces a meaningful error.
    state.hostStopFails = 'io error: simulated';
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    // The transport's `closedByPeer` flag is set; the cleanup
    // promise resolved (with the error swallowed). The next
    // startHost should await the (already-resolved) promise and
    // proceed to a fresh host_start. The host_stop failure is
    // visible only via the console.debug log, not as a thrown
    // error to the caller.
    state.hostLink = null;
    state.hostPollPeerClosed = false;
    await expect(t.startHost('DEF456')).resolves.toBeDefined();
    await t.disconnect();
  });

  it('Task 1: disconnect after peer-closed does not issue a second host_stop', async () => {
    // Q2: "同一连接是否可能同时触发多个清理任务？" — verifying
    // the disconnect path is also idempotent when the peer-close
    // cleanup is already in flight. The `disconnect()` method
    // checks `closedByPeer` and awaits the existing promise
    // instead of dispatching a fresh host_stop.
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    const stopsBefore = state.callLog.filter((c) => c === 'lan_host_stop').length;
    expect(stopsBefore).toBe(1);
    await t.disconnect();
    const stopsAfter = state.callLog.filter((c) => c === 'lan_host_stop').length;
    // No second host_stop should be issued — the existing
    // cleanupPromise is awaited, not duplicated.
    expect(stopsAfter).toBe(1);
  });

  // ---- Phase 16.5 § Task 2: closedByPeer lifecycle ----

  it('Task 2: a fresh connection on the same instance does NOT inherit the previous connection closedByPeer', async () => {
    // The core Task 2 scenario. Sequence on ONE transport:
    //   1. startHost('ABC')
    //   2. peer drops (onClose fires)
    //   3. startHost('DEF') on the SAME instance
    //   4. the new peer's drop fires onClose (would NOT happen if
    //      closedByPeer were instance-scoped instead of
    //      connection-scoped).
    //
    // The handler for the new connection MUST be registered
    // AFTER startHost, because `onClose` has a late-subscriber
    // microtask that fires the handler immediately if
    // `closedByPeer` is already true at registration time (the
    // transport's API contract for late subscribers to a close
    // event that already happened). Registering before startHost
    // would conflate the late-subscriber firing with a real new
    // peer-close event.
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });

    // First connection: peer drops, onClose fires.
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    let firstFired = 0;
    t.onClose(() => {
      firstFired += 1;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(firstFired).toBe(1);

    // Same instance, second connection. closedByPeer must be
    // reset so a NEW peer-close event is observable. The handler
    // is registered AFTER startHost to avoid the late-subscriber
    // microtask path.
    state.hostLink = null;
    state.hostStarted = false;
    state.hostPollPeerClosed = false;
    await t.startHost('DEF456');
    let secondFired = 0;
    t.onClose(() => {
      secondFired += 1;
    });
    // Bring a peer up and let it drop.
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    await new Promise((r) => setTimeout(r, 500));
    // The second close MUST fire — this is the bug Phase 16.5
    // fixes. If `closedByPeer` were instance-scoped (the
    // pre-Phase-16.5 behaviour), this would still be 0.
    expect(secondFired).toBe(1);
    // The first handler is still on the handler set, but its
    // state was reset by startHost — verify it did NOT fire
    // again (it was cleared by the second startHost, so the
    // counter stays at 1 from the first connection).
    expect(firstFired).toBe(1);

    await t.disconnect();
  });

  it('Task 2: disconnect resets closedByPeer so the next startHost is clean', async () => {
    // Disconnect is a normal teardown path. After it, the
    // transport must be in a state equivalent to a fresh
    // instance: closedByPeer = false, closeHandlers empty, mode
    // = idle. The new connection's handler is registered AFTER
    // startHost to avoid the late-subscriber microtask path.
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startHost('ABC123');
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    t.onClose(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    await t.disconnect();

    // Now start a new host and verify onClose can fire again.
    state.hostLink = null;
    state.hostStarted = false;
    state.hostPollPeerClosed = false;
    await t.startHost('DEF456');
    let fired = 0;
    t.onClose(() => {
      fired += 1;
    });
    state.hostLink = { inbound: [], outbound: [], connected: true };
    state.hostPollPeerClosed = true;
    await new Promise((r) => setTimeout(r, 500));
    expect(fired).toBe(1);
    await t.disconnect();
  });

  it('Task 2: same instance joiner → peer-closed → joiner again — second close fires', async () => {
    // Same lifecycle test on the joiner side, to prove the
    // closedByPeer reset is symmetric across host and join.
    // The handler is registered AFTER startJoin to avoid the
    // late-subscriber microtask path.
    state.discoverResults = [
      { ip: '192.168.1.10', port: 52420, agent_id: 'peer', display_name: 'Peer', code: 'ABC123' },
    ];
    const t = new LanTransport({ selfAgentId: 'self', selfDisplayName: 'Self' });
    await t.startJoin(state.discoverResults[0]!);
    state.joinPollPeerClosed = true;
    let firstFired = 0;
    t.onClose(() => {
      firstFired += 1;
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(firstFired).toBe(1);

    // Same instance, second join.
    state.joinStarted = false;
    state.joinLink = null;
    state.joinPollPeerClosed = false;
    state.discoverResults = [
      { ip: '192.168.1.11', port: 52421, agent_id: 'peer2', display_name: 'Peer 2', code: 'DEF456' },
    ];
    await t.startJoin(state.discoverResults[0]!);
    let secondFired = 0;
    t.onClose(() => {
      secondFired += 1;
    });
    state.joinPollPeerClosed = true;
    await new Promise((r) => setTimeout(r, 500));
    expect(secondFired).toBe(1);

    await t.disconnect();
  });
});

// Suppress the afterEach's "unhandled rejection" by giving it a body.
afterEach(() => {
  // intentionally empty
});
// Avoid vi unused warning.
void vi;
