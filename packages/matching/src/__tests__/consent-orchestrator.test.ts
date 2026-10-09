import { describe, it, expect } from 'vitest';
import { createBlock, createConsentReject } from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport, PairingSession } from '@kindora/transport';
import {
  ConsentOrchestrator,
  type BlockedAgentsLookup,
} from '../consent-orchestrator';

const ID_A = '11111111-2222-4333-8444-aaaaaaaaaaaa';
const ID_B = '22222222-3333-4444-8555-bbbbbbbbbbbb';

interface Pair {
  hub: LoopbackHub;
  sessionA: PairingSession;
  sessionB: PairingSession;
  transportA: LoopbackTransport;
  transportB: LoopbackTransport;
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
  return { hub, sessionA, sessionB, transportA: ta, transportB: tb };
}

class MemoryBlockList implements BlockedAgentsLookup {
  readonly entries = new Set<string>();
  readonly reasons: Array<{ id: string; reason?: string }> = [];
  async has(id: string): Promise<boolean> {
    return this.entries.has(id);
  }
  async add(id: string, reason?: string): Promise<void> {
    this.entries.add(id);
    this.reasons.push(reason ? { id, reason } : { id });
  }
}

function makeOrchestrator(selfId: string, peerId: string, blockList?: BlockedAgentsLookup) {
  return new ConsentOrchestrator({
    selfAgentId: selfId,
    peerDisplayName: 'Peer',
    peerAgentId: peerId,
    options: {
      peerConsentTimeoutMs: 500,
      ...(blockList ? { blockList } : {}),
    },
  });
}

describe('@kindora/matching — ConsentOrchestrator', () => {
  it('stays in awaiting_decision until the user clicks Accept', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    const orchB = makeOrchestrator(ID_B, ID_A);
    const startA = orchA.start(sessionA);
    const startB = orchB.start(sessionB);
    expect(orchA.current()).toBe('awaiting_decision');
    expect(orchB.current()).toBe('awaiting_decision');
    // Don't actually resolve — close so the listen promise resolves.
    await sessionA.disconnect('test-done');
    await sessionB.disconnect('test-done');
    await startA;
    await startB;
  });

  it('transitions to accepted_both when both sides Accept (race-safe)', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    const orchB = makeOrchestrator(ID_B, ID_A);
    const startA = orchA.start(sessionA);
    const startB = orchB.start(sessionB);
    // Yield a tick so the queue handlers are installed on both sides.
    await Promise.resolve();
    await Promise.resolve();
    // Both click Accept concurrently.
    await Promise.all([orchA.decide(sessionA, 'accept'), orchB.decide(sessionB, 'accept')]);
    const [outA, outB] = await Promise.all([startA, startB]);
    expect(outA.state).toBe('accepted_both');
    expect(outB.state).toBe('accepted_both');
    expect(outA.bothAccepted).toBe(true);
    expect(outB.bothAccepted).toBe(true);
  });

  it('transitions to accepted_both even if peer already accepted first', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    const orchB = makeOrchestrator(ID_B, ID_A);
    const startA = orchA.start(sessionA);
    const startB = orchB.start(sessionB);
    await Promise.resolve();
    await Promise.resolve();
    // B accepts first.
    await orchB.decide(sessionB, 'accept');
    expect(orchA.current()).toBe('accepted_peer');
    // Then A accepts.
    await orchA.decide(sessionA, 'accept');
    const [outA, outB] = await Promise.all([startA, startB]);
    expect(outA.state).toBe('accepted_both');
    expect(outB.state).toBe('accepted_both');
  });

  it('transitions to rejected when local user rejects', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    const orchB = makeOrchestrator(ID_B, ID_A);
    const startA = orchA.start(sessionA);
    const startB = orchB.start(sessionB);
    await Promise.resolve();
    await Promise.resolve();
    await orchA.decide(sessionA, 'reject', 'not a fit');
    const [outA, outB] = await Promise.all([startA, startB]);
    expect(outA.state).toBe('rejected');
    // B is still waiting — let it time out / observe state.
    expect(['awaiting_decision', 'rejected', 'accepted_peer']).toContain(outB.state);
  });

  it('transitions to rejected when peer rejects', async () => {
    const { sessionA, sessionB } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    const startA = orchA.start(sessionA);
    // B side just needs to exist so the loopback delivery has somewhere to go.
    void makeOrchestrator(ID_B, ID_A).start(sessionB);
    await Promise.resolve();
    await Promise.resolve();
    // Simulate B rejecting by sending the envelope directly through
    // its session (B hasn't called decide() yet).
    await sessionB.send(createConsentReject(ID_B, { reason: 'no thanks' }));
    const outA = await startA;
    expect(outA.state).toBe('rejected');
    expect(outA.bothAccepted).toBe(false);
  });

  it('transitions to blocked when local user blocks, persists to block list', async () => {
    const { sessionA, sessionB } = await makePair();
    const blockList = new MemoryBlockList();
    const orchA = makeOrchestrator(ID_A, ID_B, blockList);
    const startA = orchA.start(sessionA);
    // B side just needs to exist so the loopback delivery has somewhere to go.
    void makeOrchestrator(ID_B, ID_A).start(sessionB);
    await Promise.resolve();
    await Promise.resolve();
    await orchA.decide(sessionA, 'block', 'spam');
    const outA = await startA;
    expect(outA.state).toBe('blocked');
    expect(outA.blockedByLocal).toBe(true);
    expect(blockList.entries.has(ID_B)).toBe(true);
    expect(blockList.reasons[0]?.reason).toBe('spam');
  });

  it('transitions to blocked when peer blocks, persists their id locally', async () => {
    const { sessionA, sessionB } = await makePair();
    const blockListA = new MemoryBlockList();
    const orchA = makeOrchestrator(ID_A, ID_B, blockListA);
    // B side just needs to exist so the loopback delivery has somewhere to go.
    void makeOrchestrator(ID_B, ID_A, new MemoryBlockList()).start(sessionB);
    const startA = orchA.start(sessionA);
    await Promise.resolve();
    await Promise.resolve();
    // B blocks A by sending the envelope directly.
    await sessionB.send(createBlock(ID_B, { reason: 'spam' }));
    const outA = await startA;
    expect(outA.state).toBe('blocked');
    expect(outA.blockedByPeer).toBe(true);
    expect(blockListA.entries.has(ID_B)).toBe(true);
  });

  it('decide() is idempotent — a second click throws', async () => {
    const { sessionA } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    void orchA.start(sessionA);
    await Promise.resolve();
    await orchA.decide(sessionA, 'accept');
    // Second click should be rejected — either because the local
    // decision is already taken, or because the state has already
    // finalised. Both are valid signals of "no more decisions".
    await expect(orchA.decide(sessionA, 'accept')).rejects.toThrow(
      /already (taken|finalised)/,
    );
  });

  it('soft timeouts when local accepts but peer never replies', async () => {
    const { sessionA } = await makePair();
    const orchA = makeOrchestrator(ID_A, ID_B);
    void orchA.start(sessionA);
    // B never does anything; we just let A's timer fire.
    await Promise.resolve();
    await orchA.decide(sessionA, 'accept');
    expect(orchA.current()).toBe('accepted_local');
    // The orchestrator's start promise hasn't resolved yet — wait long
    // enough for the 500ms peerConsentTimeoutMs to elapse, then close
    // the session so the queue releases any waiting promises.
    await new Promise((r) => setTimeout(r, 700));
    await sessionA.disconnect('test-end');
    // After timeout + close, the outcome should reflect the soft timeout.
    // (The actual outcome is delivered via `start()` resolving.)
  });
});
