/**
 * The chat persistence port — Phase D / D2.
 *
 * The orchestrator writes every message down through the
 * {@link ChatPersistence} port. The tests pin the two things the task
 * book asks for:
 *
 *   - the message is written down **before** it goes out, and its state
 *     follows what actually happened (D2 requirements 2, 3, 9);
 *   - a storage failure never stops the conversation (the user is
 *     talking to a person, not to a disk).
 *
 * The port itself is a test double here — it records the calls. The
 * repository that actually writes to the database is covered by
 * `@kindora/storage`'s own tests.
 */

import { describe, it, expect } from 'vitest';
import { LoopbackHub, LoopbackTransport, PairingSession } from '@kindora/transport';
import { createChatMessage } from '@kindora/protocol';

import {
  ChatOrchestrator,
  type ChatPersistence,
  type PendingChatMessage,
  type ReceivedChatMessage,
} from '../chat-orchestrator';

const ID_A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const ID_B = '22222222-3333-4444-8555-bbbbbbbbbbbb';
const SESSION_ID = 'session-1';

interface RecordedCall {
  readonly kind: 'pending' | 'sent' | 'failed' | 'received';
  readonly messageId: string;
  readonly sessionId?: string;
  readonly text?: string;
  readonly source?: string;
  readonly reason?: string;
}

interface Recorder {
  readonly port: ChatPersistence;
  readonly calls: RecordedCall[];
  readonly order: string[];
  /** When set, every call throws this error. */
  failWith: Error | null;
}

function recorder(order: string[] = []): Recorder {
  const calls: RecordedCall[] = [];
  const state: Recorder = {
    calls,
    order,
    failWith: null,
    port: {
      async recordPending(message: PendingChatMessage): Promise<void> {
        calls.push({
          kind: 'pending',
          messageId: message.messageId,
          sessionId: message.sessionId,
          text: message.text,
          source: message.source,
        });
        order.push('pending');
        if (state.failWith) throw state.failWith;
      },
      async markSent(messageId: string): Promise<void> {
        calls.push({ kind: 'sent', messageId });
        order.push('sent');
        if (state.failWith) throw state.failWith;
      },
      async markFailed(messageId: string, reason: string): Promise<void> {
        calls.push({ kind: 'failed', messageId, reason });
        order.push('failed');
        if (state.failWith) throw state.failWith;
      },
      async recordReceived(message: ReceivedChatMessage): Promise<void> {
        calls.push({
          kind: 'received',
          messageId: message.messageId,
          text: message.text,
          source: message.source,
        });
        order.push('received');
        if (state.failWith) throw state.failWith;
      },
    },
  };
  return state;
}

/**
 * A session that only does what the test needs it to.
 *
 * It is used for the cases where the *transport* has to fail — a real
 * loopback session cannot be made to fail on demand. It is a test
 * double, not a second device: it says nothing about how two real
 * agents talk to each other.
 */
function fakeSession(order: string[], sendError?: Error): PairingSession {
  return {
    async send(): Promise<void> {
      order.push('send');
      if (sendError) throw sendError;
    },
    current: () => ({ state: 'connected' }),
    onMessage: () => () => undefined,
    onStateChange: () => () => undefined,
    async disconnect(): Promise<void> {
      order.push('disconnect');
    },
  } as unknown as PairingSession;
}

async function makePair(): Promise<{ sessionA: PairingSession; sessionB: PairingSession }> {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
  const sessionB = new PairingSession({ agentId: ID_B, displayName: 'Bob' });
  const ta = new LoopbackTransport({ endpointId: ID_A, hub });
  const tb = new LoopbackTransport({ endpointId: ID_B, hub });
  const code = sessionA.startHost(ta);
  await sessionB.startJoin(tb, code);
  if (ta.isConnected()) sessionA.notifyPeerConnected();
  if (sessionA.current().state === 'tcp-connected') sessionA.notifyHelloReceived(ID_B);
  if (sessionB.current().state === 'tcp-connected') sessionB.notifyHelloReceived(ID_A);
  return { sessionA, sessionB };
}

function makeOrchestrator(options: {
  persistence?: ChatPersistence;
  sessionId?: string;
}): ChatOrchestrator {
  return new ChatOrchestrator({
    selfAgentId: ID_A,
    peerAgentId: ID_B,
    peerDisplayName: 'Bob',
    options: {
      ...(options.persistence ? { persistence: options.persistence } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    },
  });
}

describe('ChatOrchestrator — the persistence port', () => {
  it('writes the message down before it goes out', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    await orch.send(fakeSession(order), 'hello');

    expect(order).toEqual(['pending', 'send', 'sent']);
  });

  it('marks the message as sent when the transport accepted it', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    const entry = await orch.send(fakeSession(order), 'hello');

    expect(entry.status).toBe('SENT');
    expect(rec.calls.map((c) => c.kind)).toEqual(['pending', 'sent']);
    expect(rec.calls[1]?.messageId).toBe(entry.id);
  });

  it('persists the message under the same id as the entry', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    const entry = await orch.send(fakeSession(order), 'hello');

    expect(rec.calls[0]?.messageId).toBe(entry.id);
    expect(rec.calls[0]?.text).toBe('hello');
    expect(rec.calls[0]?.source).toBe('human');
  });

  it('records who wrote the text (D2 requirement 6)', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    await orch.send(fakeSession(order), 'an icebreaker', 'agent');

    expect(rec.calls[0]?.source).toBe('agent');
  });

  it('writes the session id into the persisted row', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    await orch.send(fakeSession(order), 'hello');

    // The port is called with the session id, so the row can be found
    // again after a restart.
    expect(rec.calls[0]?.sessionId).toBe(SESSION_ID);
  });

  it('leaves a failed message visible as FAILED (D2 requirement 3)', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    await expect(
      orch.send(fakeSession(order, new Error('transport closed')), 'hello'),
    ).rejects.toThrow(/transport closed/);

    // The message is still in the history — it did not vanish.
    const entries = orch.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('FAILED');
    expect(entries[0]?.text).toBe('hello');

    expect(order).toEqual(['pending', 'send', 'failed']);
    expect(rec.calls[1]?.kind).toBe('failed');
    expect(rec.calls[1]?.reason).toBe('transport closed');
  });

  it('a storage failure does not stop the conversation', async () => {
    const order: string[] = [];
    const rec = recorder(order);
    rec.failWith = new Error('database is locked');
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    const entry = await orch.send(fakeSession(order), 'hello');

    expect(entry.status).toBe('SENT');
    expect(orch.snapshot().entries).toHaveLength(1);
  });

  it('persists nothing when no port is configured', async () => {
    const order: string[] = [];
    const orch = makeOrchestrator({});

    const entry = await orch.send(fakeSession(order), 'hello');

    expect(order).toEqual(['send']);
    expect(entry.status).toBe('SENT');
  });

  it('persists nothing when there is no session id', async () => {
    // Without a session the rows could not be found again, so the
    // orchestrator leaves the port alone entirely.
    const order: string[] = [];
    const rec = recorder(order);
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: '' });

    await orch.send(fakeSession(order), 'hello');

    expect(order).toEqual(['send']);
    expect(rec.calls).toEqual([]);
  });
});

describe('ChatOrchestrator — incoming messages', () => {
  it('records a received message', async () => {
    const { sessionA, sessionB } = await makePair();
    const rec = recorder();
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    const startPromise = orch.start(sessionA);
    await sessionB.send(createChatMessage(ID_B, { text: 'hi from bob' }));
    await new Promise((r) => setTimeout(r, 30));

    const received = rec.calls.find((c) => c.kind === 'received');
    expect(received).toBeDefined();
    expect(received?.text).toBe('hi from bob');

    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('marks a received message as DELIVERED — its arrival is the receipt', async () => {
    const { sessionA, sessionB } = await makePair();
    const rec = recorder();
    const orch = makeOrchestrator({ persistence: rec.port, sessionId: SESSION_ID });

    const startPromise = orch.start(sessionA);
    await sessionB.send(createChatMessage(ID_B, { text: 'hi from bob' }));
    await new Promise((r) => setTimeout(r, 30));

    const entries = orch.snapshot().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('DELIVERED');
    expect(entries[0]?.direction).toBe('received');

    await orch.disconnect(sessionA);
    await startPromise;
  });
});
