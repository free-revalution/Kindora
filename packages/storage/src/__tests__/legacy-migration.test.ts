/**
 * The localStorage → database migration — Phase D / D1 (requirements 11, 12).
 *
 * The two rules the task book asks for are pinned here:
 *
 *   - 「数据迁移应支持失败恢复」 — a failed migration leaves the old data
 *     where it was, and the next start tries again;
 *   - 「数据库迁移失败时原数据不丢失」 — nothing is deleted before it has
 *     been written to the database.
 *
 * The private key is the third rule: it never reaches the database.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_SOCIAL_BOUNDARIES,
  PROTOCOL_VERSION,
} from '@kindora/protocol';

import { InMemoryKindoraDatabase } from '../memory-database';
import {
  emptyLegacyMigrationReport,
  migrateLegacyLocalStorage,
  type LegacyStorageSource,
} from '../legacy-migration';
import type { BlockedAgent } from '../blocked-agents-store';
import type { StoredAgent } from '../profile-store';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const PEER_ID = '11111111-2222-4333-8444-aaaaaaaaaaaa';

function makeAgent(overrides: Partial<StoredAgent> = {}): StoredAgent {
  return {
    agentId: AGENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    displayName: 'Jason',
    publicKey: 'PUB',
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

/** The legacy localStorage, in memory. */
class FakeLegacySource implements LegacyStorageSource {
  agent: StoredAgent | null = null;
  settings: Record<string, unknown> = {};
  blocked: BlockedAgent[] = [];

  constructor(private readonly log: string[] = []) {}

  readAgent(): StoredAgent | null {
    this.log.push('readAgent');
    return this.agent;
  }

  readSettings(): Record<string, unknown> {
    this.log.push('readSettings');
    return { ...this.settings };
  }

  readBlockedAgents(): readonly BlockedAgent[] {
    this.log.push('readBlockedAgents');
    return [...this.blocked];
  }

  removeAgent(): void {
    this.log.push('removeAgent');
    this.agent = null;
  }

  removeSetting(key: string): void {
    this.log.push(`removeSetting:${key}`);
    delete this.settings[key];
  }

  removeBlockedAgents(): void {
    this.log.push('removeBlockedAgents');
    this.blocked = [];
  }
}

/** A database that records what it was asked to do, and can be told to fail. */
class LoggingDatabase extends InMemoryKindoraDatabase {
  constructor(
    private readonly log: string[],
    readonly schemaVersion = 1,
  ) {
    super(schemaVersion);
  }

  /** The call that should fail, e.g. 'saveAgent'. */
  failOn: string | null = null;

  override async saveAgent(agent: StoredAgent): Promise<void> {
    this.log.push('saveAgent');
    if (this.failOn === 'saveAgent') throw new Error('disk is full');
    await super.saveAgent(agent);
  }

  override async setSetting<T>(key: string, value: T): Promise<void> {
    this.log.push(`setSetting:${key}`);
    if (this.failOn === `setSetting:${key}`) throw new Error('disk is full');
    await super.setSetting(key, value);
  }

  override async addBlockedAgent(agentId: string, reason?: string): Promise<void> {
    this.log.push('addBlockedAgent');
    if (this.failOn === 'addBlockedAgent') throw new Error('disk is full');
    await super.addBlockedAgent(agentId, reason);
  }
}

describe('migrateLegacyLocalStorage — a successful move', () => {
  it('moves the agent, the settings and the block list into the database', async () => {
    const log: string[] = [];
    const source = new FakeLegacySource(log);
    source.agent = makeAgent();
    source.settings = { uiLocale: 'zh' };
    source.blocked = [{ agentId: PEER_ID, blockedAt: '2026-01-01T00:00:00.000Z' }];
    const database = new LoggingDatabase(log);

    const report = await migrateLegacyLocalStorage(database, source);

    expect(report.failed).toBe(false);
    expect(report.migratedAgent).toBe(true);
    expect(report.migratedSettings).toEqual(['uiLocale']);
    expect(report.migratedBlockedAgents).toBe(1);

    expect((await database.getAgent())?.agentId).toBe(AGENT_ID);
    expect(await database.getSetting('uiLocale')).toBe('zh');
    expect(await database.isAgentBlocked(PEER_ID)).toBe(true);
  });

  it('removes the legacy copy only after the database write succeeded', async () => {
    const log: string[] = [];
    const source = new FakeLegacySource(log);
    source.agent = makeAgent();
    source.settings = { uiLocale: 'zh' };
    source.blocked = [{ agentId: PEER_ID, blockedAt: '2026-01-01T00:00:00.000Z' }];
    const database = new LoggingDatabase(log);

    await migrateLegacyLocalStorage(database, source);

    const indexOf = (needle: string): number => log.indexOf(needle);
    expect(indexOf('saveAgent')).toBeGreaterThanOrEqual(0);
    expect(indexOf('saveAgent')).toBeLessThan(indexOf('removeAgent'));
    expect(indexOf('setSetting:uiLocale')).toBeLessThan(indexOf('removeSetting:uiLocale'));
    expect(indexOf('addBlockedAgent')).toBeLessThan(indexOf('removeBlockedAgents'));
  });

  it('empties the legacy storage afterwards', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent();
    source.settings = { uiLocale: 'zh' };
    source.blocked = [{ agentId: PEER_ID, blockedAt: '2026-01-01T00:00:00.000Z' }];
    const database = new LoggingDatabase([]);

    await migrateLegacyLocalStorage(database, source);

    expect(source.agent).toBeNull();
    expect(source.settings).toEqual({});
    expect(source.blocked).toEqual([]);
  });

  it('is idempotent — a second run has nothing left to do', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent();
    source.settings = { uiLocale: 'zh' };
    const database = new LoggingDatabase([]);

    await migrateLegacyLocalStorage(database, source);
    const second = await migrateLegacyLocalStorage(database, source);

    expect(second.migratedAgent).toBe(false);
    expect(second.migratedSettings).toEqual([]);
    expect(second.failed).toBe(false);
    expect(await database.getSetting('uiLocale')).toBe('zh');
  });

  it('reports nothing migrated when there is nothing to migrate', async () => {
    const source = new FakeLegacySource();
    const database = new LoggingDatabase([]);

    const report = await migrateLegacyLocalStorage(database, source);

    expect(report).toEqual(emptyLegacyMigrationReport());
  });
});

describe('migrateLegacyLocalStorage — a failure', () => {
  it('leaves the legacy data alone when the agent write fails', async () => {
    const log: string[] = [];
    const source = new FakeLegacySource(log);
    source.agent = makeAgent();
    const database = new LoggingDatabase(log);
    database.failOn = 'saveAgent';

    const report = await migrateLegacyLocalStorage(database, source);

    expect(report.failed).toBe(true);
    expect(report.error).toMatch(/disk is full/i);
    // The old copy is still there — nothing was lost.
    expect(source.agent).not.toBeNull();
    expect(await database.getAgent()).toBeNull();
  });

  it('leaves the legacy settings alone when the setting write fails', async () => {
    const source = new FakeLegacySource();
    source.settings = { uiLocale: 'zh' };
    const database = new LoggingDatabase([]);
    database.failOn = 'setSetting:uiLocale';

    const report = await migrateLegacyLocalStorage(database, source);

    expect(report.failed).toBe(true);
    expect(source.settings.uiLocale).toBe('zh');
  });

  it('never throws — the caller has to be able to carry on', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent();
    const database = new LoggingDatabase([]);
    database.failOn = 'saveAgent';

    await expect(migrateLegacyLocalStorage(database, source)).resolves.toBeDefined();
  });

  it('reports what it did manage to migrate before the failure', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent();
    source.settings = { uiLocale: 'zh' };
    const database = new LoggingDatabase([]);
    database.failOn = 'setSetting:uiLocale';

    const report = await migrateLegacyLocalStorage(database, source);

    expect(report.failed).toBe(true);
    expect(report.migratedAgent).toBe(true);
    expect(report.migratedSettings).toEqual([]);
  });
});

describe('migrateLegacyLocalStorage — the private key', () => {
  it('never writes a private key into the database', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent({
      privateKey: 'PRIVATE-SECRET',
      privateKeyStorage: { kind: 'dev-localstorage' },
    });
    const database = new LoggingDatabase([]);

    const report = await migrateLegacyLocalStorage(database, source);

    // The report says the key was left behind, so the caller can warn.
    expect(report.agentPrivateKeyLeftBehind).toBe(true);

    const stored = await database.getAgent();
    expect(stored?.privateKey).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-SECRET');
  });

  it('does not report a key left behind when there was none', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent();
    const database = new LoggingDatabase([]);

    const report = await migrateLegacyLocalStorage(database, source);
    expect(report.agentPrivateKeyLeftBehind).toBe(false);
  });

  it('runs the prepare hook first and stores its result', async () => {
    const source = new FakeLegacySource();
    source.agent = makeAgent({
      privateKey: 'PRIVATE-SECRET',
      privateKeyStorage: { kind: 'dev-localstorage' },
    });
    const database = new LoggingDatabase([]);

    const report = await migrateLegacyLocalStorage(database, source, {
      prepareAgent: async (raw) => ({
        ...raw,
        privateKey: undefined,
        privateKeyStorage: { kind: 'keychain', keyId: 'key-id-123' },
      }),
    });

    // The hook removed the key, so nothing was left behind.
    expect(report.agentPrivateKeyLeftBehind).toBe(false);

    const stored = await database.getAgent();
    expect(stored?.privateKeyStorage).toEqual({ kind: 'keychain', keyId: 'key-id-123' });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE-SECRET');
  });
});
