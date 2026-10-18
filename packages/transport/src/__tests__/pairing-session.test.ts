import { describe, it, expect, vi } from 'vitest';
import {
  createDisconnect,
  type KsaMessage,
  SensitiveFieldError,
} from '@kindora/protocol';
import {
  LoopbackHub,
  LoopbackTransport,
  PairingSession,
  WireRateLimitExceeded,
} from '../index';

const A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function makeFixture(opts: Partial<ConstructorParameters<typeof PairingSession>[0]> = {}) {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: A, displayName: 'A', ...opts });
  const sessionB = new PairingSession({ agentId: B, displayName: 'B', ...opts });
  const ta = new LoopbackTransport({ endpointId: A, hub });
  const tb = new LoopbackTransport({ endpointId: B, hub });
  return { hub, sessionA, sessionB, ta, tb };
}

async function pairThem(
  sessionA: PairingSession,
  sessionB: PairingSession,
  ta: LoopbackTransport,
  tb: LoopbackTransport,
  opts: { handshake?: boolean } = {},
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
  // Optional Phase 15 helper: simulate the orchestrator having
  // validated each side's `hello` envelope so the sessions reach
  // 'connected'. Tests that need to drive the handshake themselves
  // pass `{ handshake: false }`.
  if (opts.handshake !== false) {
    if (sessionA.current().state === 'tcp-connected') {
      sessionA.notifyHelloReceived(B);
    }
    if (sessionB.current().state === 'tcp-connected') {
      sessionB.notifyHelloReceived(A);
    }
  }
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

  describe('Phase 11 — security hardening', () => {
    it('rejects outbound envelopes carrying forbidden field names', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture();
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);

      // Hand-craft an envelope that names a forbidden field.
      // We must include protocol + version + UUID v4 messageId so the
      // transport's own envelope validator doesn't reject it before
      // our guard runs.
      const bad = {
        protocol: 'KSA',
        version: '0.1',
        messageId: '11111111-2222-4333-8444-555555555555',
        type: 'chat_message',
        sender: A,
        timestamp: new Date().toISOString(),
        payload: { text: 'hi', apiKey: 'not-a-real-key' },
      } as unknown as KsaMessage;

      await expect(sessionA.send(bad)).rejects.toThrow(SensitiveFieldError);
    });

    it('skips the guard when guardSensitiveFields=false', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture({ guardSensitiveFields: false });
      const received: KsaMessage[] = [];
      sessionB.onMessage((m) => received.push(m));
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);

      const weird = {
        protocol: 'KSA',
        version: '0.1',
        messageId: '22222222-3333-4444-8555-666666666666',
        type: 'chat_message',
        sender: A,
        timestamp: new Date().toISOString(),
        payload: { text: 'hi', apiKey: 'fake' },
      } as unknown as KsaMessage;

      // Should pass through even though "apiKey" is forbidden by the guard.
      await sessionA.send(weird);
      expect(received).toHaveLength(1);
    });

    it('throws WireRateLimitExceeded when send exceeds the outbound bucket', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture({
        rateLimiterOptions: {
          outbound: { capacity: 1, refillPerSecond: 1 },
          inbound: { capacity: 100, refillPerSecond: 100 },
        },
      });
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);

      await sessionA.send(createDisconnect(A, { reason: 'first' }));
      await expect(sessionA.send(createDisconnect(A, { reason: 'second' }))).rejects.toThrow(
        WireRateLimitExceeded,
      );
    });

    it('silently drops inbound messages when the inbound bucket is empty', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture({
        rateLimiterOptions: {
          outbound: { capacity: 100, refillPerSecond: 100 },
          inbound: { capacity: 1, refillPerSecond: 0.01 }, // 1 token per 100s
        },
      });
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);

      const received: KsaMessage[] = [];
      sessionB.onMessage((m) => received.push(m));

      await sessionA.send(createDisconnect(A, { reason: 'one' }));
      await sessionA.send(createDisconnect(A, { reason: 'two' }));
      await sessionA.send(createDisconnect(A, { reason: 'three' }));

      // Only the first one (within the 1-token bucket) should reach the handler.
      expect(received.map((m) => m.payload)).toEqual([
        expect.objectContaining({ reason: 'one' }),
      ]);
    });

    it('rateLimiter=null disables all rate limiting', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture({ rateLimiter: null });
      const received: KsaMessage[] = [];
      sessionB.onMessage((m) => received.push(m));
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);

      // No outbound limits either — 5 should all pass.
      for (let i = 0; i < 5; i++) {
        await sessionA.send(createDisconnect(A, { reason: `r${i}` }));
      }
      expect(received).toHaveLength(5);
    });
  });

  describe('Phase 15 — TCP-connected vs protocol-handshake-complete', () => {
    it('startJoin transitions to tcp-connected (not connected) on transport.connect()', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      // Per Phase 15: TCP link is up but the peer's `hello` has not
      // been received / validated yet, so the session is in
      // 'tcp-connected', not 'connected'. This is the V0.1 wire
      // semantics: wire up ≠ handshake complete.
      expect(sessionB.current().state).toBe('tcp-connected');
      expect(sessionB.current().peerAgentId).toBeNull();
    });

    it('startHost waits in hosting until notifyTransportConnected, then tcp-connected', async () => {
      const { sessionA, ta } = makeFixture();
      sessionA.startHost(ta);
      expect(sessionA.current().state).toBe('hosting');
      sessionA.notifyTransportConnected();
      expect(sessionA.current().state).toBe('tcp-connected');
      expect(sessionA.current().peerAgentId).toBeNull();
    });

    it('notifyHelloReceived transitions tcp-connected → connected and locks in the peer id', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      sessionB.notifyHelloReceived(A);
      const snap = sessionB.current();
      expect(snap.state).toBe('connected');
      expect(snap.peerAgentId).toBe(A);
    });

    it('notifyHelloReceived throws when the peerAgentId is empty or not a UUID', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      expect(() => sessionB.notifyHelloReceived('')).toThrow(/non-empty/);
      expect(() => sessionB.notifyHelloReceived('not-a-uuid')).toThrow(/UUID/);
    });

    it('notifyHelloReceived refuses the self agentId', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      expect(() => sessionB.notifyHelloReceived(B)).toThrow(/self/);
    });

    it('notifyHelloReceived is only valid from tcp-connected', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture();
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);
      // pairThem default is to also notify hello → state is 'connected'.
      expect(sessionA.current().state).toBe('connected');
      expect(() => sessionA.notifyHelloReceived('11111111-2222-4333-8444-cccccccccccc')).toThrow(
        /tcp-connected/,
      );
    });

    it('failHandshake from tcp-connected transitions to closed and tears down the transport', async () => {
      const { sessionB, tb } = makeFixture();
      const disconnectSpy = vi.spyOn(tb, 'disconnect');
      await sessionB.startJoin(tb, 'ABCDEF');
      expect(sessionB.current().state).toBe('tcp-connected');
      await sessionB.failHandshake('hello-timeout');
      const snap = sessionB.current();
      expect(snap.state).toBe('closed');
      expect(snap.closeReason).toBe('hello-timeout');
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });

    it('failHandshake is a no-op from closed (idempotent)', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture();
      sessionA.startHost(ta);
      await pairThem(sessionA, sessionB, ta, tb);
      await sessionA.disconnect('first');
      // After disconnect the state is 'closed'. A second failHandshake
      // must not throw and must not overwrite closeReason.
      await sessionA.failHandshake('second');
      expect(sessionA.current().state).toBe('closed');
      expect(sessionA.current().closeReason).toBe('first');
    });

    it('send works in tcp-connected (orchestrator can send its own hello before the peer replies)', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture();
      sessionA.startHost(ta);
      // Pair without the simulated handshake — sessions are in
      // 'tcp-connected' on both sides.
      await pairThem(sessionA, sessionB, ta, tb, { handshake: false });
      const received: KsaMessage[] = [];
      sessionB.onMessage((m) => received.push(m));
      await sessionA.send(createDisconnect(A, { reason: 'tcp-connected-send' }));
      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe('disconnect');
    });

    it('rejects send in idle / hosting / joining / closed', async () => {
      const { sessionA, sessionB, ta, tb } = makeFixture();
      sessionA.startHost(ta);
      await expect(sessionA.send(createDisconnect(A))).rejects.toThrow(
        /Cannot send in state "hosting"/,
      );
      await pairThem(sessionA, sessionB, ta, tb);
      await sessionA.disconnect('done');
      await expect(sessionA.send(createDisconnect(A))).rejects.toThrow(
        /Cannot send in state "closed"/,
      );
    });

    it('legacy notifyPeerConnected is an alias for notifyTransportConnected (tcp-connected, not connected)', async () => {
      const { sessionA, ta } = makeFixture();
      sessionA.startHost(ta);
      sessionA.notifyPeerConnected(); // legacy: peerAgentId arg is ignored
      expect(sessionA.current().state).toBe('tcp-connected');
      expect(sessionA.current().peerAgentId).toBeNull();
    });
  });

  // ---- Phase 16.4: peer-close propagation ----

  describe('peer-close hook (Transport.onClose)', () => {
    it('drives the session to closed with reason peer-closed when the transport fires onClose', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      // Simulate a peer-side drop while the session is in
      // 'tcp-connected' (no hello exchange yet).
      tb.simulatePeerClose();
      // Allow the microtask queue to drain.
      await new Promise((r) => setTimeout(r, 10));
      const snap = sessionB.current();
      expect(snap.state).toBe('closed');
      expect(snap.closeReason).toBe('peer-closed');
    });

    it('drives the session to closed from hosting (host-side pre-accept drop)', async () => {
      const { sessionA, ta } = makeFixture();
      sessionA.startHost(ta);
      // Host is in 'hosting' (peer not yet arrived).
      ta.simulatePeerClose();
      await new Promise((r) => setTimeout(r, 10));
      const snap = sessionA.current();
      expect(snap.state).toBe('closed');
      expect(snap.closeReason).toBe('peer-closed');
    });

    it('local disconnect clears the close handler — a subsequent onClose is ignored', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      await sessionB.disconnect('user-cancel');
      // After disconnect, the handler is unsubscribed. A late
      // simulatePeerClose must not flip the state to closed again
      // (it should already be 'closed' with the user-cancel reason).
      tb.simulatePeerClose();
      await new Promise((r) => setTimeout(r, 10));
      const snap = sessionB.current();
      expect(snap.state).toBe('closed');
      expect(snap.closeReason).toBe('user-cancel');
    });

    it('idempotency: two onClose firings on the same transport drive the session to closed exactly once with the right reason', async () => {
      const { sessionB, tb } = makeFixture();
      await sessionB.startJoin(tb, 'ABCDEF');
      // Manually fire onClose twice. The transport guarantees
      // single-fire, but even if a buggy transport fired twice, the
      // session's `failHandshake` is idempotent — the second call
      // must not overwrite `closeReason`.
      tb.simulatePeerClose();
      tb.simulatePeerClose();
      await new Promise((r) => setTimeout(r, 10));
      const snap = sessionB.current();
      expect(snap.state).toBe('closed');
      expect(snap.closeReason).toBe('peer-closed');
    });

    it('reconnect after peer-close: a fresh PairingSession on a fresh transport transitions to connected', async () => {
      // First session: peer closes mid-handshake.
      const first = makeFixture();
      await first.sessionB.startJoin(first.tb, 'ABCDEF');
      first.tb.simulatePeerClose();
      await new Promise((r) => setTimeout(r, 10));
      expect(first.sessionB.current().state).toBe('closed');

      // Second session: a fresh PairingSession on the same hub
      // using a fresh transport. Must reach 'connected' cleanly.
      const second = makeFixture();
      const code = second.sessionA.startHost(second.ta);
      await pairThem(second.sessionA, second.sessionB, second.ta, second.tb);
      expect(second.sessionA.current().state).toBe('connected');
      expect(second.sessionB.current().state).toBe('connected');
      expect(code).toHaveLength(6);
    });
  });
});
