/**
 * The desktop chat persistence adapter — Phase D / D2.
 *
 * The adapter is the seam between the `ChatPersistence` port (in
 * `@kindora/matching`) and the `ChatRepository` (in `@kindora/storage`).
 * The tests use the in-memory database, so they exercise the real
 * repository code — no Tauri runtime, no SQLite file.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryKindoraDatabase, type KindoraDatabase } from '@kindora/storage';

import { DesktopChatPersistence } from '../lib/chat-persistence';

const SELF_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

function makeAdapter(options?: { sessionId?: string }): {
  adapter: DesktopChatPersistence;
  database: InMemoryKindoraDatabase;
  opened: () => number;
} {
  const database = new InMemoryKindoraDatabase(1);
  let opened = 0;
  const adapter = new DesktopChatPersistence({
    selfAgentId: SELF_ID,
    peerAgentId: PEER_ID,
    peerDisplayName: 'Bob',
    ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    database: async (): Promise<KindoraDatabase> => {
      opened += 1;
      return database;
    },
  });
  return { adapter, database, opened: () => opened };
}

describe('DesktopChatPersistence', () => {
  it('opens the session row on the first write', async () => {
    const { adapter, database } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    const sessions = await database.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('session-1');
    expect(sessions[0]?.peerAgentId).toBe(PEER_ID);
    expect(sessions[0]?.peerDisplayName).toBe('Bob');
  });

  it('writes an outgoing message as PENDING and marks it sent', async () => {
    const { adapter, database } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    let stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('PENDING');
    expect(stored[0]?.text).toBe('hello');
    expect(stored[0]?.source).toBe('human');

    await adapter.markSent('msg-1');

    stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('SENT');
    expect(stored[0]?.sentAt).not.toBeNull();
  });

  it('marks a message as failed and keeps the reason', async () => {
    const { adapter, database } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });
    await adapter.markFailed('msg-1', 'transport closed');

    const stored = await database.listMessages('session-1');
    expect(stored[0]?.status).toBe('FAILED');
    expect(stored[0]?.failureReason).toBe('transport closed');
  });

  it('records a received message as DELIVERED', async () => {
    const { adapter, database } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordReceived({
      sessionId: 'session-1',
      senderAgentId: PEER_ID,
      text: 'hi from bob',
      source: 'human',
      messageId: 'envelope-1',
    });

    const stored = await database.listMessages('session-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('DELIVERED');
    expect(stored[0]?.direction).toBe('received');
    expect(stored[0]?.text).toBe('hi from bob');
  });

  it('owns the session id — a caller cannot orphan a row', async () => {
    const { adapter, database } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordPending({
      sessionId: 'a-different-session',
      senderAgentId: SELF_ID,
      text: 'hello',
      source: 'human',
      messageId: 'msg-1',
    });

    // The message landed in the session the adapter opened.
    expect(await database.listMessages('session-1')).toHaveLength(1);
    expect(await database.listMessages('a-different-session')).toHaveLength(0);
  });

  it('generates a session id when none is given', () => {
    const { adapter } = makeAdapter();
    expect(adapter.id.length).toBeGreaterThan(0);
  });

  it('opens the database only once', async () => {
    const { adapter, opened } = makeAdapter({ sessionId: 'session-1' });

    await adapter.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'one',
      source: 'human',
      messageId: 'msg-1',
    });
    await adapter.markSent('msg-1');
    await adapter.recordPending({
      sessionId: 'session-1',
      senderAgentId: SELF_ID,
      text: 'two',
      source: 'human',
      messageId: 'msg-2',
    });

    expect(opened()).toBe(1);
  });
});
