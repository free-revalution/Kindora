import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserLocalStorageBlockedAgentsStore,
  InMemoryBlockedAgentsStore,
} from '../blocked-agents-store';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('@kindora/storage — BlockedAgentsStore (in-memory)', () => {
  let store: InMemoryBlockedAgentsStore;
  beforeEach(() => {
    store = new InMemoryBlockedAgentsStore();
  });

  it('starts empty', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.has(A)).toBe(false);
  });

  it('adds a blocked agent and lists them', async () => {
    await store.add(A, 'spam');
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.agentId).toBe(A);
    expect(all[0]?.reason).toBe('spam');
    expect(all[0]?.blockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await store.has(A)).toBe(true);
  });

  it('is idempotent — re-adding updates reason and blockedAt without duplicating', async () => {
    await store.add(A, 'first');
    await store.add(B, 'second');
    await store.add(A, 'updated');
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.agentId === A)?.reason).toBe('updated');
  });

  it('removes a blocked agent', async () => {
    await store.add(A);
    await store.remove(A);
    expect(await store.list()).toEqual([]);
    expect(await store.has(A)).toBe(false);
  });

  it('remove() is a no-op when the id is not blocked', async () => {
    await store.add(A);
    await store.remove(B);
    expect(await store.has(A)).toBe(true);
  });

  it('clear() wipes the list', async () => {
    await store.add(A);
    await store.add(B);
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('rejects invalid agent ids', async () => {
    await expect(store.add('not-a-uuid')).rejects.toThrow(/Invalid agent id/);
    await expect(store.add('')).rejects.toThrow(/Invalid agent id/);
  });
});

describe('@kindora/storage — BrowserLocalStorageBlockedAgentsStore', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('round-trips through localStorage', async () => {
    const s1 = new BrowserLocalStorageBlockedAgentsStore();
    await s1.add(A, 'round-trip');
    const s2 = new BrowserLocalStorageBlockedAgentsStore();
    expect(await s2.has(A)).toBe(true);
    const all = await s2.list();
    expect(all[0]?.reason).toBe('round-trip');
  });

  it('survives malformed JSON in storage by returning an empty list', async () => {
    globalThis.localStorage.setItem(
      'kindora:phase7:blocked-agents:v1',
      'this is not json',
    );
    const s = new BrowserLocalStorageBlockedAgentsStore();
    expect(await s.list()).toEqual([]);
  });

  it('drops entries that do not have a valid agentId', async () => {
    globalThis.localStorage.setItem(
      'kindora:phase7:blocked-agents:v1',
      JSON.stringify([
        { agentId: A, blockedAt: '2026-01-01T00:00:00Z' },
        { agentId: 'garbage', blockedAt: '2026-01-01T00:00:00Z' },
        { blockedAt: '2026-01-01T00:00:00Z' },
        'not-an-object',
      ]),
    );
    const s = new BrowserLocalStorageBlockedAgentsStore();
    const all = await s.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.agentId).toBe(A);
  });
});
