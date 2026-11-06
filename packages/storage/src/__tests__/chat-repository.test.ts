/**
 * The chat repository — Phase D / D2.
 *
 * The repository owns the transcript: it decides what is written down,
 * in which order, and what state a message is in afterwards.
 *
 * The two rules the task book asks for are pinned here:
 *
 *   - a message is written down **before** it is sent, so a crash
 *     cannot make it disappear (D2 requirement 2);
 *   - an outbound message may never claim to be `DELIVERED` without a
 *     receipt, because KSA 0.1 has none (D2 requirement 9).
 */

import { describe, it, expect } from 'vitest';

import { ChatRepository } from '../chat-repository';
import { InMemoryKindoraDatabase } from '../memory-database';

const SELF_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

function makeRepository(): {
  repository: ChatRepository;
  database: InMemoryKindoraDatabase;
} {
  const database = new InMemoryKindoraDatabase(1);
  const repository = new ChatRepository({
    database,
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { repository, database };
}

describe('ChatRepository — sessions', () => {
  it('records the session before the first message', async () => {
    const { repository, database } = makeRepository();

    const session = await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });

    expect(session.sessionId).toBe('session-1');
    expect(session.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(session.endedAt).toBeNull();

    // A session that produced no message at all is still visible.
    const sessions = await database.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('session-1');
  });

  it('generates a session id when none is given', async () => {
    const { repository } = makeRepository();
    const session = await repository.openSession({
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });
    expect(session.sessionId.length).toBeGreaterThan(0);
  });

  it('closes a session with a reason', async () => {
    const { repository, database } = makeRepository();
    await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });

    await repository.closeSession('session-1', 'user-disconnect');

    const closed = await database.getSession('session-1');
    expect(closed?.endedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(closed?.closeReason).toBe('user-disconnect');
  });

  it('closing an unknown session is a no-op', async () => {
    const { repository } = makeRepository();
    await expect(repository.closeSession('nope', 'bye')).resolves.toBeUndefined();
  });
});

describe('ChatRepository — outgoing messages', () => {
  it('writes an outgoing message down as PENDING', async () => {
    const { repository, database } = makeRepository();
    await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });

    const message = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
    });

    expect(message.status).toBe('PENDING');
    expect(message.direction).toBe('sent');
    expect(message.source).toBe('human');
    expect(message.sentAt).toBeNull();
    expect(message.seq).toBe(1);

    const stored = await database.listMessages('session-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('PENDING');
  });

  it('records who wrote the text (D2 requirement 6)', async () => {
    const { repository } = makeRepository();
    const message = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'an icebreaker',
      source: 'agent',
    });
    expect(message.source).toBe('agent');
  });

  it('marks a message as sent', async () => {
    const { repository, database } = makeRepository();
    const message = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    await repository.markSent(message.messageId);

    const stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('SENT');
    expect(stored[0]?.sentAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stored[0]?.deliveredAt).toBeNull();
  });

  it('marks a message as failed and keeps the reason', async () => {
    const { repository, database } = makeRepository();
    const message = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    await repository.markFailed(message.messageId, 'transport closed');

    const stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('FAILED');
    expect(stored[0]?.failedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stored[0]?.failureReason).toBe('transport closed');
  });

  it('gives every message its own id (D2 requirement 7)', async () => {
    const { repository } = makeRepository();
    const first = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'one',
      source: 'human',
    });
    const second = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'two',
      source: 'human',
    });
    expect(first.messageId).not.toBe(second.messageId);
  });
});

describe('ChatRepository — delivery receipts', () => {
  it('refuses to mark an outbound message as delivered without a receipt', async () => {
    const { repository } = makeRepository();

    await expect(
      (repository as unknown as { markDelivered(id: string): Promise<void> }).markDelivered(
        'msg-1',
      ),
    ).rejects.toThrow(/receipt/i);
  });

  it('refuses a receipt without an id', async () => {
    const { repository } = makeRepository();

    await expect(
      repository.markDelivered('msg-1', {
        receiptId: '',
        receivedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/receipt/i);
  });

  it('marks a message as delivered when a receipt is produced', async () => {
    const { repository, database } = makeRepository();
    const message = await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    await repository.markDelivered(message.messageId, {
      receiptId: 'ack-1',
      receivedAt: '2026-01-01T00:00:05.000Z',
    });

    const stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('DELIVERED');
    expect(stored[0]?.deliveredAt).toBe('2026-01-01T00:00:05.000Z');
  });
});

describe('ChatRepository — incoming messages', () => {
  it('records a received message as DELIVERED — its arrival is the receipt', async () => {
    const { repository, database } = makeRepository();

    const message = await repository.recordReceived({
      sessionId: 'session-1',
      senderAgentId: PEER_ID,
      text: 'hi from bob',
      source: 'human',
      messageId: 'envelope-1',
    });

    expect(message.status).toBe('DELIVERED');
    expect(message.direction).toBe('received');
    expect(message.deliveredAt).toBe('2026-01-01T00:00:00.000Z');

    const stored = await database.listMessages('session-1');
    expect(stored[0]?.messageId).toBe('envelope-1');
  });

  it('reuses the envelope id, so a replayed envelope is stored once', async () => {
    const { repository, database } = makeRepository();

    await repository.recordReceived({
      sessionId: 'session-1',
      senderAgentId: PEER_ID,
      text: 'hi from bob',
      source: 'human',
      messageId: 'envelope-1',
    });
    await repository.recordReceived({
      sessionId: 'session-1',
      senderAgentId: PEER_ID,
      text: 'hi from bob',
      source: 'human',
      messageId: 'envelope-1',
    });

    const stored = await database.listMessages('session-1');
    expect(stored).toHaveLength(1);
  });
});

describe('ChatRepository — resuming', () => {
  it('resumes the most recent session with its transcript', async () => {
    const { repository } = makeRepository();
    await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });
    await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
    });

    const resumed = await repository.resumeSession();

    expect(resumed?.session.sessionId).toBe('session-1');
    expect(resumed?.messages).toHaveLength(1);
    expect(resumed?.messages[0]?.text).toBe('hello');
  });

  it('resumes a session by its id', async () => {
    const { repository } = makeRepository();
    await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });
    await repository.openSession({
      sessionId: 'session-2',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });

    const resumed = await repository.resumeSession('session-1');
    expect(resumed?.session.sessionId).toBe('session-1');
  });

  it('returns null when there is nothing to resume', async () => {
    const { repository } = makeRepository();
    expect(await repository.resumeSession()).toBeNull();
  });

  it('lists the sessions', async () => {
    const { repository } = makeRepository();
    await repository.openSession({
      sessionId: 'session-1',
      peerAgentId: PEER_ID,
      peerDisplayName: 'Bob',
    });
    expect(await repository.listSessions()).toHaveLength(1);
  });
});

describe('ChatRepository — the transcript', () => {
  it('returns the transcript in order', async () => {
    const { repository } = makeRepository();
    await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'first',
      source: 'human',
    });
    await repository.recordReceived({
      sessionId: 'session-1',
      senderAgentId: PEER_ID,
      text: 'second',
      source: 'human',
      messageId: 'envelope-1',
    });
    await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'third',
      source: 'human',
    });

    const history = await repository.history('session-1');
    expect(history.map((m) => m.text)).toEqual(['first', 'second', 'third']);
    expect(history.map((m) => m.direction)).toEqual(['sent', 'received', 'sent']);
  });

  it('keeps the sessions apart', async () => {
    const { repository } = makeRepository();
    await repository.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'one',
      source: 'human',
    });
    await repository.recordPending({
      sessionId: 'session-2',
      senderAgentId: SELF_ID,
      text: 'two',
      source: 'human',
    });

    expect(await repository.history('session-1')).toHaveLength(1);
    expect(await repository.history('session-2')).toHaveLength(1);
  });
});
