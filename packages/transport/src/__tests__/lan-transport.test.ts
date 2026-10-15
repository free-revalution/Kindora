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
        case 'lan_host_stop':
          state.hostStarted = false;
          state.hostLink = null;
          return null;
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
        case 'lan_join_disconnect':
          state.joinStarted = false;
          state.joinLink = null;
          return null;
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
});

// Suppress the afterEach's "unhandled rejection" by giving it a body.
afterEach(() => {
  // intentionally empty
});
// Avoid vi unused warning.
void vi;
