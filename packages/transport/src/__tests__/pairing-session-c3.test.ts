/**
 * PairingSession — the reconnect contract (Phase C / C3).
 *
 * The task book asks for three things a reconnect must get right, and
 * this file pins each of them:
 *
 *   - **§ 2 — no resource leak.** The session registers exactly one
 *     transport-level message handler. A session that is torn down (or
 *     reset) must release it, or the old transport keeps feeding a
 *     session that is supposed to be gone — and a reconnect adds a
 *     second handler on top of it.
 *   - **§ 5 — the handshake is redone.** After a reset the FSM is
 *     back at `idle`, the peer identity is forgotten, and the next
 *     pairing has to run the whole handshake again. Nothing may be
 *     carried over from the link that died.
 *   - **§ 6 — no dead key is reused.** The ephemeral key pair is
 *     minted fresh, and the anti-replay guard survives the reset
 *     (replay protection must outlive a reconnect).
 *
 * The `Transport` here is a small recording double rather than the
 * loopback transport, because these tests are about what the session
 * does *to* its transport — how many handlers it leaves behind, and
 * whether the old transport can still talk to it.
 */

import { describe, expect, it } from 'vitest';
import type { KsaMessage } from '@kindora/protocol';
import {
  LoopbackHub,
  LoopbackTransport,
  PairingSession,
  type CloseHandler,
  type MessageHandler,
  type Transport,
} from '../index';

const A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

/**
 * A transport that records what the session does to it.
 *
 * It never delivers anything by itself — `deliver()` hands a message
 * to whatever handlers the session has left attached, which is
 * exactly what the "does the old transport still feed the session?"
 * question needs.
 */
interface RecordingTransport {
  readonly transport: Transport;
  /** The message handlers currently attached to the transport. */
  readonly handlers: Set<MessageHandler>;
  /** The close handlers currently attached to the transport. */
  readonly closeHandlers: Set<CloseHandler>;
  readonly calls: { connect: number; disconnect: number };
  deliver(message: KsaMessage): void;
}

function makeRecordingTransport(): RecordingTransport {
  const handlers = new Set<MessageHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const calls = { connect: 0, disconnect: 0 };
  const transport: Transport = {
    async connect() {
      calls.connect += 1;
    },
    async send() {
      // Nothing to deliver to — this double has no peer.
    },
    onMessage(handler: MessageHandler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler: CloseHandler) {
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    async disconnect() {
      calls.disconnect += 1;
    },
  };
  return {
    transport,
    handlers,
    closeHandlers,
    calls,
    deliver(message: KsaMessage) {
      for (const handler of Array.from(handlers)) handler(message);
    },
  };
}

/**
 * A host session that has completed its handshake with a joiner.
 */
async function makePaired() {
  const hub = new LoopbackHub();
  const session = new PairingSession({ agentId: A, displayName: 'A' });
  const peer = new PairingSession({ agentId: B, displayName: 'B' });
  const hostTransport = new LoopbackTransport({ endpointId: A, hub });
  const joinTransport = new LoopbackTransport({ endpointId: B, hub });

  const code = session.startHost(hostTransport);
  await peer.startJoin(joinTransport, code);
  session.notifyTransportConnected();
  session.notifyHelloReceived(B);

  return { hub, session, peer, hostTransport, joinTransport, code };
}

/** A valid, signer-less `chat_message` envelope. */
function chatEnvelope(text: string): KsaMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'chat_message',
    sender: B,
    payload: { text },
  };
}

describe('PairingSession — Phase C / C3 (no leaks, redone handshake, no dead keys)', () => {
  describe('§ 2 — the transport-level message handler is released', () => {
    it('disconnect releases the message handler and the close handler', async () => {
      const rec = makeRecordingTransport();
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      await session.startJoin(rec.transport, 'ABCDEF');

      // The session owns exactly one transport-level handler.
      expect(rec.handlers.size).toBe(1);
      expect(rec.closeHandlers.size).toBe(1);

      await session.disconnect('user-cancel');

      expect(rec.handlers.size).toBe(0);
      expect(rec.closeHandlers.size).toBe(0);
      expect(rec.calls.disconnect).toBe(1);
    });

    it('resetForReconnect releases the message handler and the close handler', async () => {
      const rec = makeRecordingTransport();
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      await session.startJoin(rec.transport, 'ABCDEF');
      expect(rec.handlers.size).toBe(1);

      await session.resetForReconnect();

      expect(rec.handlers.size).toBe(0);
      expect(rec.closeHandlers.size).toBe(0);
    });

    it('after a reset the old transport can no longer feed the session', async () => {
      const rec = makeRecordingTransport();
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      const got: KsaMessage[] = [];
      session.onMessage((m) => got.push(m));

      await session.startJoin(rec.transport, 'ABCDEF');
      await session.resetForReconnect();

      // The dead peer's traffic must not reach the session any more.
      rec.deliver(chatEnvelope('from the dead peer'));
      expect(got).toHaveLength(0);
    });

    it('a reconnect does not stack a second handler on the transport', async () => {
      const rec = makeRecordingTransport();
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      await session.startJoin(rec.transport, 'ABCDEF');
      await session.resetForReconnect();

      // The same transport instance is re-bound — the session must
      // have released the old handler before it attached the new one.
      await session.startJoin(rec.transport, 'ABCDEF');
      expect(rec.handlers.size).toBe(1);
      expect(rec.closeHandlers.size).toBe(1);
    });
  });

  describe('§ 5 — the handshake is redone', () => {
    it('resetForReconnect returns the FSM to idle and forgets the peer', async () => {
      const { session } = await makePaired();
      expect(session.current().state).toBe('connected');
      expect(session.current().peerAgentId).toBe(B);

      await session.resetForReconnect();

      const snap = session.current();
      expect(snap.state).toBe('idle');
      expect(snap.code).toBeNull();
      expect(snap.closeReason).toBeNull();
      expect(snap.peerAgentId).toBeNull();
      expect(snap.sessionEncrypted).toBe(false);
    });

    it('the peer id cannot be reused after a reset', async () => {
      const { session } = await makePaired();
      await session.resetForReconnect();

      // The FSM is back at `idle`, so the old `notifyHelloReceived` is
      // no longer valid: the next connection has to run the handshake
      // again rather than inherit the previous peer's identity.
      expect(() => session.notifyHelloReceived(B)).toThrow(/tcp-connected/);
    });

    it('after a reset the session can host again on a fresh transport', async () => {
      const { hub, session, joinTransport } = await makePaired();
      await session.resetForReconnect();

      // The old transport went down with the link, so the reconnect
      // binds a fresh one.
      const freshHostTransport = new LoopbackTransport({ endpointId: A, hub });
      const code = session.startHost(freshHostTransport);
      expect(session.current().state).toBe('hosting');
      expect(code).toHaveLength(6);

      // And a peer can pair with it again — the handshake runs again
      // from the top.
      const peer = new PairingSession({ agentId: B, displayName: 'B' });
      await peer.startJoin(joinTransport, code);
      session.notifyTransportConnected();
      session.notifyHelloReceived(B);
      expect(session.current().state).toBe('connected');
      expect(session.current().peerAgentId).toBe(B);
    });
  });

  describe('§ 6 — no dead key is reused', () => {
    it('resetForReconnect mints a fresh ephemeral key pair', async () => {
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      const first = await session.sessionKeyExchange();
      expect(first).not.toBeNull();
      expect(first?.ephemeralPublicKey).toBeTruthy();

      await session.resetForReconnect();

      const second = await session.sessionKeyExchange();
      expect(second).not.toBeNull();
      // Reusing the old ephemeral key would make the new session key
      // derivable from the old transcript.
      expect(second?.ephemeralPublicKey).not.toBe(first?.ephemeralPublicKey);
    });

    it('the anti-replay guard survives a reset', async () => {
      const rec = makeRecordingTransport();
      const session = new PairingSession({ agentId: A, displayName: 'A' });
      await session.startJoin(rec.transport, 'ABCDEF');
      const got: KsaMessage[] = [];
      session.onMessage((m) => got.push(m));

      const envelope = chatEnvelope('once');
      rec.deliver(envelope);
      expect(got).toHaveLength(1);
      expect(session.replayRejectionCount()).toBe(0);

      // The link dies and the session is reset for a reconnect.
      await session.resetForReconnect();

      // The SAME envelope, replayed on the new link, must still be
      // rejected — replay protection has to outlive a reconnect.
      const fresh = makeRecordingTransport();
      await session.startJoin(fresh.transport, 'ABCDEF');
      fresh.deliver(envelope);
      expect(got).toHaveLength(1);
      expect(session.replayRejectionCount()).toBe(1);
    });
  });
});
