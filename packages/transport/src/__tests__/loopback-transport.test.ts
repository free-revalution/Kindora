import { describe, it, expect } from 'vitest';
import { createDisconnect, type KsaMessage } from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport, type MessageHandler } from '../index';

const A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function makePair(code: string) {
  const hub = new LoopbackHub();
  const ta = new LoopbackTransport({ endpointId: A, hub });
  const tb = new LoopbackTransport({ endpointId: B, hub });
  // Host goes first; joiner comes second.
  ta.connect({ agentId: A, displayName: A, hint: code });
  tb.connect({ agentId: B, displayName: B, hint: code });
  return { hub, ta, tb };
}

describe('@kindora/transport — LoopbackTransport', () => {
  it('pairs two endpoints sharing a pairing code', () => {
    const { ta, tb } = makePair('ABCDEF');
    expect(ta.isConnected()).toBe(true);
    expect(tb.isConnected()).toBe(true);
  });

  it('delivers envelopes from one endpoint to the other', async () => {
    const { ta, tb } = makePair('ABCDEF');
    const received: KsaMessage[] = [];
    tb.onMessage((m) => received.push(m));

    const env = createDisconnect(A, { reason: 'test' });
    await ta.send(env);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('disconnect');
    if (received[0]?.type === 'disconnect') {
      expect(received[0].payload.reason).toBe('test');
    }
  });

  it('throws on send before connect', async () => {
    const hub = new LoopbackHub();
    const t = new LoopbackTransport({ endpointId: A, hub });
    await expect(t.send(createDisconnect(A))).rejects.toThrow();
  });

  it('connect enters the pairing room without throwing if no peer is present', async () => {
    const hub = new LoopbackHub();
    const t = new LoopbackTransport({ endpointId: A, hub });
    await t.connect({ agentId: A, displayName: A, hint: 'NOONE' });
    expect(t.isConnected()).toBe(false);
  });

  it('connect pairs immediately when a peer is already in the room', async () => {
    const hub = new LoopbackHub();
    const ta = new LoopbackTransport({ endpointId: A, hub });
    const tb = new LoopbackTransport({ endpointId: B, hub });
    await ta.connect({ agentId: A, displayName: A, hint: 'MEET1' });
    expect(ta.isConnected()).toBe(false);
    await tb.connect({ agentId: B, displayName: B, hint: 'MEET1' });
    expect(ta.isConnected()).toBe(true);
    expect(tb.isConnected()).toBe(true);
  });

  it('connect requires PeerInfo.hint (pairing code)', async () => {
    const hub = new LoopbackHub();
    const t = new LoopbackTransport({ endpointId: A, hub });
    await expect(t.connect({ agentId: A, displayName: A })).rejects.toThrow(/hint/i);
  });

  it('disconnect removes the endpoint from the hub', async () => {
    const hub = new LoopbackHub();
    const t = new LoopbackTransport({ endpointId: A, hub });
    await t.disconnect();
    expect(t.isConnected()).toBe(false);
    expect(() => hub.register(A)).not.toThrow();
  });

  it('reset clears all rooms and disconnect states', () => {
    const hub = new LoopbackHub();
    const t1 = new LoopbackTransport({ endpointId: A, hub });
    const t2 = new LoopbackTransport({ endpointId: B, hub });
    // Connect both endpoints with the same code — this pairs them.
    t1.connect({ agentId: A, displayName: A, hint: 'ROOM01' });
    t2.connect({ agentId: B, displayName: B, hint: 'ROOM01' });
    expect(t1.isConnected()).toBe(true);
    expect(t2.isConnected()).toBe(true);
    hub.reset();
    expect(t1.isConnected()).toBe(false);
    expect(t2.isConnected()).toBe(false);
  });

  it('does not deliver a message when send happens before connect', async () => {
    const hub = new LoopbackHub();
    const ta = new LoopbackTransport({ endpointId: A, hub });
    const tb = new LoopbackTransport({ endpointId: B, hub });
    const received: KsaMessage[] = [];
    tb.onMessage(((m: KsaMessage) => received.push(m)) as MessageHandler);
    await expect(ta.send(createDisconnect(A))).rejects.toThrow();
    expect(received).toHaveLength(0);
  });
});
