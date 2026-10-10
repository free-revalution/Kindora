import { describe, it, expect } from 'vitest';
import { LoopbackHub, LoopbackTransport, PairingSession } from '@kindora/transport';
import {
  ChatOrchestrator,
  type BlockedAgentsLookup,
  type ChatSnapshot,
} from '../chat-orchestrator';

const ID_A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const ID_B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

function stubBlockList(): BlockedAgentsLookup & { blocked: string[] } {
  const blocked: string[] = [];
  return {
    blocked,
    async has(id: string) {
      return blocked.includes(id);
    },
    async add(id: string) {
      if (!blocked.includes(id)) blocked.push(id);
    },
  };
}

interface Pair {
  sessionA: PairingSession;
  sessionB: PairingSession;
}

async function makePair(): Promise<Pair> {
  const hub = new LoopbackHub();
  const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
  const sessionB = new PairingSession({ agentId: ID_B, displayName: 'Bob' });
  const ta = new LoopbackTransport({ endpointId: ID_A, hub });
  const tb = new LoopbackTransport({ endpointId: ID_B, hub });
  const code = sessionA.startHost(ta);
  await sessionB.startJoin(tb, code);
  if (ta.isConnected()) sessionA.notifyPeerConnected();
  return { sessionA, sessionB };
}

describe('@kindora/matching — ChatOrchestrator', () => {
  it('starts with an empty, open snapshot', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    const snap = orch.snapshot();
    expect(snap.state).toBe('open');
    expect(snap.entries).toEqual([]);
    expect(snap.closeReason).toBe('open');
    expect(snap.peerAgentId).toBe(ID_B);
    expect(snap.peerDisplayName).toBe('Bob');
    expect(snap.blockedByLocal).toBe(false);
    expect(snap.blockedByPeer).toBe(false);
    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('appends sent entries to history on send()', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    const entry = await orch.send(sessionA, 'hello there');
    expect(entry.direction).toBe('sent');
    expect(entry.sender).toBe(ID_A);
    expect(entry.text).toBe('hello there');
    expect(orch.snapshot().entries).toEqual([entry]);
    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('appends received entries when peer sends a chat_message', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orchA.start(sessionA);
    const { createChatMessage } = await import('@kindora/protocol');
    await sessionB.send(createChatMessage(ID_B, { text: 'hi from bob' }));
    await new Promise((r) => setTimeout(r, 10));
    const snap = orchA.snapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0]?.direction).toBe('received');
    expect(snap.entries[0]?.sender).toBe(ID_B);
    expect(snap.entries[0]?.text).toBe('hi from bob');
    await orchA.disconnect(sessionA);
    await startPromise;
  });

  it('drops chat_messages from a sender that is not the peer (§ 50)', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orchA.start(sessionA);
    const { createChatMessage, createHello, DEFAULT_AGENT_CAPABILITIES } = await import('@kindora/protocol');
    // A "fake peer" envelope with the wrong sender id (impersonator).
    await sessionB.send(
      createChatMessage('00000000-0000-0000-0000-000000000000', { text: 'spoofed' }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(orchA.snapshot().entries).toEqual([]);
    // A proper hello envelope (not a chat_message) is also ignored.
    await sessionB.send(
      createHello(ID_B, {
        displayName: 'Bob',
        capabilities: DEFAULT_AGENT_CAPABILITIES,
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(orchA.snapshot().entries).toEqual([]);
    await orchA.disconnect(sessionA);
    await startPromise;
  });

  it('bidirectional: both sides see sent + received entries in order', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const orchB = new ChatOrchestrator({
      selfAgentId: ID_B,
      peerAgentId: ID_A,
      peerDisplayName: 'Alice',
    });
    const startA = orchA.start(sessionA);
    const startB = orchB.start(sessionB);

    await orchA.send(sessionA, 'A1');
    await orchB.send(sessionB, 'B1');
    await orchA.send(sessionA, 'A2');

    await new Promise((r) => setTimeout(r, 10));

    const snapA = orchA.snapshot();
    const snapB = orchB.snapshot();
    expect(snapA.entries.map((e) => `${e.direction}:${e.text}`)).toEqual([
      'sent:A1',
      'received:B1',
      'sent:A2',
    ]);
    expect(snapB.entries.map((e) => `${e.direction}:${e.text}`)).toEqual([
      'received:A1',
      'sent:B1',
      'received:A2',
    ]);

    await orchA.disconnect(sessionA);
    await orchB.disconnect(sessionB);
    await startA;
    await startB;
  });

  it('rejects send() when chat is closed', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    await orch.disconnect(sessionA);
    await startPromise;
    await expect(orch.send(sessionA, 'too late')).rejects.toThrow(/closed/i);
  });

  it('rejects send() with empty text', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    await expect(orch.send(sessionA, '   ')).rejects.toThrow(/empty/i);
    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('rejects send() with text longer than maxTextLength', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
      options: { maxTextLength: 5 },
    });
    const startPromise = orch.start(sessionA);
    await expect(orch.send(sessionA, 'too long for the budget')).rejects.toThrow(/max/i);
    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('disconnect() closes the session and resolves start()', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    await orch.send(sessionA, 'one');
    await orch.disconnect(sessionA, 'bye');
    const finalSnap = await startPromise;
    expect(finalSnap.state).toBe('closed');
    expect(finalSnap.closeReason).toBe('user-disconnect');
    expect(finalSnap.entries).toHaveLength(1);
  });

  it('block() persists the peer id, sends a block envelope, closes the session', async () => {
    const { sessionA, sessionB } = await makePair();
    const blockList = stubBlockList();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
      options: { blockList },
    });
    const startPromise = orch.start(sessionA);
    const received: { blocks: unknown[] } = { blocks: [] };
    sessionB.onMessage((msg) => {
      if (msg.type === 'block') received.blocks.push(msg.payload);
    });
    await orch.send(sessionA, 'hi');
    await orch.block(sessionA, 'rude');
    const finalSnap = await startPromise;
    expect(finalSnap.state).toBe('closed');
    expect(finalSnap.closeReason).toBe('user-block');
    expect(finalSnap.blockedByLocal).toBe(true);
    expect(blockList.blocked).toContain(ID_B);
    expect(received.blocks).toHaveLength(1);
  });

  it('block() is idempotent — calling twice does not double-persist', async () => {
    const { sessionA } = await makePair();
    const blockList = stubBlockList();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
      options: { blockList },
    });
    const startPromise = orch.start(sessionA);
    await orch.block(sessionA);
    await orch.block(sessionA);
    expect(blockList.blocked.filter((id) => id === ID_B)).toEqual([ID_B]);
    await startPromise;
  });

  it('transitions to peer-block when peer sends a block envelope after chat unlocked', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orchA.start(sessionA);
    const { createBlock } = await import('@kindora/protocol');
    await sessionB.send(createBlock(ID_B, { reason: 'changed my mind' }));
    await new Promise((r) => setTimeout(r, 10));
    const snap = orchA.snapshot();
    expect(snap.state).toBe('closed');
    expect(snap.closeReason).toBe('peer-block');
    expect(snap.blockedByPeer).toBe(true);
    await startPromise;
  });

  it('subscribe() fires immediately with current snapshot + on every change', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    const calls: ChatSnapshot[] = [];
    const off = orch.subscribe((s) => calls.push(s));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.state).toBe('open');
    await orch.send(sessionA, 'first');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.some((s) => s.entries.length === 1)).toBe(true);
    off();
    await orch.disconnect(sessionA);
    await startPromise;
  });

  it('rejects start() when the session is not connected', async () => {
    const sessionA = new PairingSession({ agentId: ID_A, displayName: 'Alice' });
    await sessionA.disconnect('test-closed');
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    await expect(orch.start(sessionA)).rejects.toThrow(/connected/i);
  });

  it('unsubscribed listener does not fire on subsequent changes', async () => {
    const { sessionA } = await makePair();
    const orch = new ChatOrchestrator({
      selfAgentId: ID_A,
      peerAgentId: ID_B,
      peerDisplayName: 'Bob',
    });
    const startPromise = orch.start(sessionA);
    let firedAfterUnsub = 0;
    const off = orch.subscribe(() => {
      firedAfterUnsub += 1;
    });
    const before = firedAfterUnsub;
    off();
    await orch.send(sessionA, 'hi');
    expect(firedAfterUnsub).toBe(before);
    await orch.disconnect(sessionA);
    await startPromise;
  });
});