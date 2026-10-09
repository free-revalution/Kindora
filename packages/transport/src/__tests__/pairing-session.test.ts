import { describe, it, expect, vi } from 'vitest';
import { createDisconnect, type KsaMessage } from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport, PairingSession } from '../index';

const A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function makeFixture() {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: A, displayName: 'A' });
  const sessionB = new PairingSession({ agentId: B, displayName: 'B' });
  const ta = new LoopbackTransport({ endpointId: A, hub });
  const tb = new LoopbackTransport({ endpointId: B, hub });
  return { hub, sessionA, sessionB, ta, tb };
}

async function pairThem(
  sessionA: PairingSession,
  sessionB: PairingSession,
  ta: LoopbackTransport,
  tb: LoopbackTransport,
) {
  const code = sessionA.current().code;
  if (!code) throw new Error('pairThem: no pairing code in session state');
  // The host is already in the room (startHost placed it there).
  // Have the joiner connect — that triggers immediate pair on both
  // transports because A is waiting in the room.
  await sessionB.startJoin(tb, code);
  // LoopbackTransport has now paired both sides; surface that to A's
  // session so it transitions out of "hosting".
  if (ta.isConnected()) sessionA.notifyPeerConnected();
}

describe('@kindora/transport — PairingSession', () => {
  it('host path: startHost → hosting → peer joins → connected', async () => {
    const { sessionA, sessionB, ta, tb } = makeFixture();
    const generated = sessionA.startHost(ta);
    expect(typeof generated).toBe('string');
    expect(generated).toHaveLength(6);
    expect(sessionA.current().state).toBe('hosting');

    await pairThem(sessionA, sessionB, ta, tb);
    expect(sessionA.current().state).toBe('connected');
    expect(sessionB.current().state).toBe('connected');
  });

  it('join path: startJoin validates the code shape before connecting', async () => {
    const { sessionB, tb } = makeFixture();
    await expect(sessionB.startJoin(tb, 'NOT-VALID-SHAPE!!')).rejects.toThrow(/pairing code/i);
  });

  it('sends envelopes after connected', async () => {
    const { sessionA, sessionB, ta, tb } = makeFixture();
    const received: KsaMessage[] = [];
    sessionB.onMessage((m) => received.push(m));
    sessionA.startHost(ta);
    await pairThem(sessionA, sessionB, ta, tb);

    const env = createDisconnect(A, { reason: 'hi' });
    await sessionA.send(env);
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('disconnect');
  });

  it('rejects send when not connected', async () => {
    const { sessionA, ta } = makeFixture();
    sessionA.startHost(ta);
    await expect(sessionA.send(createDisconnect(A))).rejects.toThrow(/Cannot send in state/);
  });

  it('disconnect is idempotent and transitions to closed', async () => {
    const { sessionA, sessionB, ta, tb } = makeFixture();
    sessionA.startHost(ta);
    await pairThem(sessionA, sessionB, ta, tb);
    await sessionA.disconnect('test');
    expect(sessionA.current().state).toBe('closed');
    expect(sessionA.current().closeReason).toBe('test');
    await sessionA.disconnect();
    expect(sessionA.current().state).toBe('closed');
  });

  it('emits state-change events on each transition', () => {
    const { sessionA, ta } = makeFixture();
    const handler = vi.fn();
    sessionA.onStateChange(handler);
    sessionA.startHost(ta);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]?.state).toBe('hosting');
  });

  it('rejects startHost when not idle', () => {
    const { sessionA, ta } = makeFixture();
    sessionA.startHost(ta);
    expect(() => sessionA.startHost(ta)).toThrow(/Invalid state/i);
  });

  it('notifyPeerConnected only valid from hosting or joining', async () => {
    const { sessionA, sessionB, ta, tb } = makeFixture();
    sessionA.startHost(ta);
    await pairThem(sessionA, sessionB, ta, tb);
    expect(() => sessionA.notifyPeerConnected()).toThrow();
  });

  it('preserves the pairing code through hosting → connected', async () => {
    const { sessionA, sessionB, ta, tb } = makeFixture();
    const code = sessionA.startHost(ta);
    await pairThem(sessionA, sessionB, ta, tb);
    expect(sessionA.current().code).toBe(code);
  });
});
