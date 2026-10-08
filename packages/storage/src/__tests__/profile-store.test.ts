import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserLocalStorageProfileStore } from '../browser-store';
import { STORAGE_TABLES, STORAGE_PACKAGE_VERSION } from '../index';
import type { StoredAgent } from '../profile-store';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    agentId: '00000000-0000-4000-8000-000000000001',
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'Jason',
    publicKey: 'PUB',
    privateKey: 'PRIV',
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

describe('@kindora/storage', () => {
  it('exposes a version constant', () => {
    expect(STORAGE_PACKAGE_VERSION).toBe('0.1.0');
  });

  it('declares every V0.1 table from 开发手册.md § 37', () => {
    expect(STORAGE_TABLES).toContain('profiles');
    expect(STORAGE_TABLES).toContain('agents');
    expect(STORAGE_TABLES).toContain('llm_configs');
    expect(STORAGE_TABLES).toContain('connections');
    expect(STORAGE_TABLES).toContain('matches');
    expect(STORAGE_TABLES).toContain('conversations');
    expect(STORAGE_TABLES).toContain('messages');
    expect(STORAGE_TABLES).toContain('permissions');
  });
});

describe('BrowserLocalStorageProfileStore', () => {
  let store: BrowserLocalStorageProfileStore;

  beforeEach(() => {
    localStorage.clear();
    store = new BrowserLocalStorageProfileStore();
  });

  it('returns null when no agent is saved', async () => {
    expect(await store.loadAgent()).toBeNull();
    expect(await store.loadProfile()).toBeNull();
  });

  it('round-trips an agent through saveAgent / loadAgent', async () => {
    const agent = makeAgent();
    await store.saveAgent(agent);
    const loaded = await store.loadAgent();
    expect(loaded).toEqual(agent);
  });

  it('round-trips a profile through saveProfile / loadProfile', async () => {
    await store.saveAgent(makeAgent());
    const profile = await store.loadProfile();
    expect(profile?.nickname).toBe('Jason');

    await store.saveProfile({
      ...(profile as NonNullable<typeof profile>),
      nickname: 'Alex',
    });
    const reloaded = await store.loadProfile();
    expect(reloaded?.nickname).toBe('Alex');
    expect(reloaded?.bio).toBe('Software engineer.');
  });

  it('refuses to saveProfile when no agent exists yet', async () => {
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

  it('deleteAgent wipes everything', async () => {
    await store.saveAgent(makeAgent());
    await store.deleteAgent();
    expect(await store.loadAgent()).toBeNull();
    expect(await store.loadProfile()).toBeNull();
  });

  it('returns null on corrupt JSON instead of throwing', async () => {
    localStorage.setItem('kindora:agent', '{not valid');
    expect(await store.loadAgent()).toBeNull();
  });
});
