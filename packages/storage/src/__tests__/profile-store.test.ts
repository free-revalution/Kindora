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
    privateKeyStorage: { kind: 'dev-localstorage' },
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

  /* ---------------------------------------------------------------- */
  /* Phase A / A1 — the private key must not reach localStorage.        */
  /* ---------------------------------------------------------------- */

  it('never writes the private key to localStorage for a keychain-backed agent', async () => {
    await store.saveAgent(
      makeAgent({
        privateKey: 'PRIVATE-SECRET',
        privateKeyStorage: { kind: 'keychain', keyId: 'key-id-123' },
      }),
    );

    const raw = localStorage.getItem('kindora:agent');
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('PRIVATE-SECRET');
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(parsed.privateKey).toBeUndefined();
    expect(parsed.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });

    const loaded = await store.loadAgent();
    expect(loaded?.privateKey).toBeUndefined();
    expect(loaded?.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });
  });

  it('keeps the private key for the browser-dev fallback, and says so', async () => {
    await store.saveAgent(makeAgent({ privateKey: 'DEV-KEY' }));
    const raw = localStorage.getItem('kindora:agent');
    expect(raw).toContain('DEV-KEY');
    const loaded = await store.loadAgent();
    expect(loaded?.privateKey).toBe('DEV-KEY');
    expect(loaded?.privateKeyStorage).toEqual({ kind: 'dev-localstorage' });
  });

  it('normalises a pre-Phase-A record to the dev-localstorage marker', async () => {
    const legacy = {
      agentId: '00000000-0000-4000-8000-000000000002',
      protocolVersion: PROTOCOL_VERSION,
      displayName: 'Legacy',
      publicKey: 'PUB',
      privateKey: 'LEGACY-PRIV',
      profile: {
        nickname: 'Legacy',
        bio: '',
        interests: [],
        currentActivities: [],
        socialIntent: ['similar_interests'],
        conversationStyle: ['technical'],
        boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES },
      },
      capabilities: { ...DEFAULT_AGENT_CAPABILITIES },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    localStorage.setItem('kindora:agent', JSON.stringify(legacy));

    const loaded = await store.loadAgent();
    expect(loaded?.privateKey).toBe('LEGACY-PRIV');
    expect(loaded?.privateKeyStorage).toEqual({ kind: 'dev-localstorage' });
  });

  it('normalises a pre-Phase-B record to the documented default gates', async () => {
    // B1 requirement 6: 「授权设置在应用重启后保持一致」.
    //
    // A record written before the field-level gates existed does not
    // carry them. The storage boundary has to fill them in, otherwise
    // every consumer downstream sees `undefined` and cannot tell
    // "never set" from "not allowed".
    //
    // The defaults are the documented minimal-necessary set: interests
    // on, the sensitive fields off.
    const legacy = {
      ...makeAgent(),
      profile: {
        ...makeAgent().profile,
        // Exactly the KSA 0.1 shape: five behavioural flags, no gates.
        boundaries: {
          allowAgentConversation: true,
          allowContactExchange: false,
          allowOfflineMeeting: false,
          allowProjectDetails: false,
          allowCurrentActivity: false,
        },
      },
    };
    localStorage.setItem('kindora:agent', JSON.stringify(legacy));

    const loaded = await store.loadAgent();
    expect(loaded?.profile.boundaries).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
    // The gate that matters most is explicitly off, not merely absent.
    expect(loaded?.profile.boundaries.allowBio).toBe(false);
    expect(loaded?.profile.boundaries.allowInterests).toBe(true);
  });

  it('rejects a record with no profile instead of inventing one', async () => {
    // The value read back is untrusted: localStorage can be edited by
    // hand and a database row can be corrupt. `StoredAgent.profile` is
    // required, so a record without one is not an agent record.
    //
    // The tempting alternative — build a half-profile and fill in the
    // privacy gates — would produce an object that satisfies the
    // `SocialProfile` type while missing every field the user sees.
    // Returning "no agent" is the honest answer.
    const agent = makeAgent();
    localStorage.setItem('kindora:agent', JSON.stringify({ ...agent, profile: undefined }));

    expect(await store.loadAgent()).toBeNull();
    expect(await store.loadProfile()).toBeNull();
  });

  it('rejects a record whose profile is missing required fields', async () => {
    const agent = makeAgent();
    localStorage.setItem(
      'kindora:agent',
      JSON.stringify({
        ...agent,
        profile: { nickname: 'Jason' },
      }),
    );

    expect(await store.loadAgent()).toBeNull();
  });

  it('accepts a record whose profile carries no boundaries at all', async () => {
    // The field-level gates were added in Phase B. A record written
    // before them may carry only the behavioural flags — or none at
    // all — and must still load, with the documented defaults filled
    // in. This is the counterpart of the two rejections above: the
    // boundary gates are filled in, the identity fields are not.
    const agent = makeAgent();
    localStorage.setItem(
      'kindora:agent',
      JSON.stringify({
        ...agent,
        profile: {
          nickname: 'Jason',
          bio: 'Software engineer.',
          interests: ['AI'],
          currentActivities: [],
          socialIntent: ['similar_interests'],
          conversationStyle: ['technical'],
        },
      }),
    );

    const loaded = await store.loadAgent();
    expect(loaded?.profile.nickname).toBe('Jason');
    expect(loaded?.profile.boundaries).toEqual(DEFAULT_SOCIAL_BOUNDARIES);
  });

  it('keeps a stored authorisation decision across a reload', async () => {
    // The other half of B1 requirement 6: a gate the user turned ON
    // must still be ON after a restart. Normalising must not silently
    // reset a decision the user made.
    const agent = makeAgent({
      profile: {
        ...makeAgent().profile,
        boundaries: { ...DEFAULT_SOCIAL_BOUNDARIES, allowBio: true },
      },
    });
    await store.saveAgent(agent);

    const loaded = await store.loadAgent();
    expect(loaded?.profile.boundaries.allowBio).toBe(true);
    // …and the gates the user never touched keep the defaults.
    expect(loaded?.profile.boundaries.allowAvatar).toBe(false);
  });
});
