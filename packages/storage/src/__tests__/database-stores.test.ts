/**
 * The stores backed by the local database — Phase D / D1.
 *
 * The app already speaks to three narrow interfaces — `ProfileStore`,
 * `SettingsStore` and `BlockedAgentsStore` — and each one had exactly
 * one implementation: a localStorage one. These are the database
 * implementations of the same three interfaces, so the app can swap
 * them without a single call site changing.
 *
 * The tests pin the two things that make them safe to swap:
 *
 *   - they behave like the localStorage stores they replace;
 *   - they ask for the database only once, so a failure to open it is
 *     reported once and not on every read.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

import {
  DatabaseBlockedAgentsStore,
  DatabaseProfileStore,
  DatabaseSettingsStore,
} from '../database-stores';
import { InMemoryKindoraDatabase } from '../memory-database';
import type { KindoraDatabase } from '../database';
import type { StoredAgent } from '../profile-store';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    agentId: AGENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'Jason',
    publicKey: 'PUB',
    privateKey: 'PRIVATE-SECRET',
    privateKeyStorage: { kind: 'keychain', keyId: 'key-id-123' },
    profile: {
      nickname: 'Jason',
      bio: 'Software engineer.',
      interests: ['AI'],
      currentActivities: [],
      socialIntent: ['similar_interests'],
      conversationStyle: ['technical'],
      boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
    },
    capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A provider that counts how often it was asked for the database. */
function countingProvider(database: KindoraDatabase): {
  provider: () => Promise<KindoraDatabase>;
  calls: () => number;
} {
  let calls = 0;
  return {
    provider: async () => {
      calls += 1;
      return database;
    },
    calls: () => calls,
  };
}

describe('DatabaseProfileStore', () => {
  it('returns null when no agent exists on this device', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    expect(await store.loadAgent()).toBeNull();
    expect(await store.loadProfile()).toBeNull();
  });

  it('round-trips an agent', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    await store.saveAgent(makeAgent());

    const loaded = await store.loadAgent();
    expect(loaded?.agentId).toBe(AGENT_ID);
    expect(loaded?.displayName).toBe('Jason');
    expect(loaded?.profile.nickname).toBe('Jason');
  });

  it('never returns the private key — it lives in the OS keychain', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    await store.saveAgent(makeAgent());

    const loaded = await store.loadAgent();
    expect(loaded?.privateKey).toBeUndefined();
    expect(loaded?.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });
  });

  it('fills in the Phase B gates of a record written before they existed', async () => {
    const database = new InMemoryKindoraDatabase(1);
    // A record that predates the field-level gates.
    await database.saveAgent({
      ...makeAgent(),
      profile: {
        ...makeAgent().profile,
        boundaries: {
          allowAgentConversation: true,
          allowContactExchange: false,
          allowOfflineMeeting: false,
          allowProjectDetails: false,
          allowCurrentActivity: false,
        },
      },
    });
    const store = new DatabaseProfileStore(async () => database);

    const loaded = await store.loadAgent();
    expect(loaded?.profile.boundaries).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
    expect(loaded?.profile.boundaries.allowBio).toBe(false);
    expect(loaded?.profile.boundaries.allowInterests).toBe(true);
  });

  it('round-trips a profile', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    await store.saveAgent(makeAgent());

    const profile = await store.loadProfile();
    await store.saveProfile({ ...(profile as NonNullable<typeof profile>), nickname: 'Alex' });

    expect((await store.loadProfile())?.nickname).toBe('Alex');
  });

  it('refuses to save a profile when no agent exists yet', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    await expect(
      store.saveProfile({
        nickname: 'X',
        bio: 'y',
        interests: ['z'],
        currentActivities: [],
        socialIntent: ['similar_interests'],
        conversationStyle: ['casual'],
        boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
      }),
    ).rejects.toThrow(/no agent exists/i);
  });

  it('deleteAgent wipes the agent', async () => {
    const store = new DatabaseProfileStore(async () => new InMemoryKindoraDatabase(1));
    await store.saveAgent(makeAgent());
    await store.deleteAgent();
    expect(await store.loadAgent()).toBeNull();
  });

  it('asks for the database only once', async () => {
    const { provider, calls } = countingProvider(new InMemoryKindoraDatabase(1));
    const store = new DatabaseProfileStore(provider);

    await store.loadAgent();
    await store.loadAgent();
    await store.loadProfile();

    expect(calls()).toBe(1);
  });
});

describe('DatabaseSettingsStore', () => {
  it('round-trips a setting', async () => {
    const store = new DatabaseSettingsStore(async () => new InMemoryKindoraDatabase(1));
    expect(await store.get<string>('uiLocale')).toBeNull();

    await store.set('uiLocale', 'zh');
    expect(await store.get<string>('uiLocale')).toBe('zh');
  });

  it('deletes a setting', async () => {
    const store = new DatabaseSettingsStore(async () => new InMemoryKindoraDatabase(1));
    await store.set('uiLocale', 'zh');
    await store.delete('uiLocale');
    expect(await store.get('uiLocale')).toBeNull();
  });

  it('asks for the database only once', async () => {
    const { provider, calls } = countingProvider(new InMemoryKindoraDatabase(1));
    const store = new DatabaseSettingsStore(provider);

    await store.get('uiLocale');
    await store.set('uiLocale', 'zh');
    await store.get('uiLocale');

    expect(calls()).toBe(1);
  });
});

describe('DatabaseBlockedAgentsStore', () => {
  it('round-trips the block list', async () => {
    const store = new DatabaseBlockedAgentsStore(async () => new InMemoryKindoraDatabase(1));
    expect(await store.has(PEER_ID)).toBe(false);

    await store.add(PEER_ID, 'spam');
    expect(await store.has(PEER_ID)).toBe(true);
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]?.reason).toBe('spam');

    await store.remove(PEER_ID);
    expect(await store.has(PEER_ID)).toBe(false);
  });

  it('clears the whole list', async () => {
    const store = new DatabaseBlockedAgentsStore(async () => new InMemoryKindoraDatabase(1));
    await store.add(PEER_ID);
    await store.add('22222222-3333-4444-8555-bbbbbbbbbbbb');
    await store.clear();
    expect(await store.list()).toEqual([]);
  });

  it('refuses an agent id that is not a UUID', async () => {
    const store = new DatabaseBlockedAgentsStore(async () => new InMemoryKindoraDatabase(1));
    await expect(store.add('not-a-uuid')).rejects.toThrow(/invalid agent id/i);
  });

  it('asks for the database only once', async () => {
    const { provider, calls } = countingProvider(new InMemoryKindoraDatabase(1));
    const store = new DatabaseBlockedAgentsStore(provider);

    await store.list();
    await store.has(PEER_ID);
    await store.add(PEER_ID);

    expect(calls()).toBe(1);
  });
});
