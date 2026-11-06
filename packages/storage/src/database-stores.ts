/**
 * The stores, backed by the local database — Phase D / D1.
 *
 * The app already speaks to three narrow interfaces — `ProfileStore`,
 * `SettingsStore` and `BlockedAgentsStore` — and each one had exactly
 * one implementation: a localStorage one. These are the database
 * implementations of the same three interfaces, so the app can swap
 * them without a single call site changing.
 *
 * The provider is a **function**, not a database, because opening the
 * database is asynchronous (and may fail). The store asks for the
 * database the first time it needs it and keeps it.
 */

import { normaliseStoredAgent } from './browser-store';
import type { SocialProfile } from '@kindora/protocol';
import type { BlockedAgent, BlockedAgentsStore } from './blocked-agents-store';
import type { KindoraDatabase } from './database';
import type { ProfileStore, StoredAgent } from './profile-store';
import type { SettingsStore } from './settings-store';

/** Hands out the database. Called at most once per store. */
export type DatabaseProvider = () => Promise<KindoraDatabase>;

/**
 * The profile store, backed by the database.
 *
 * The private key is never in the database, so `loadAgent()` returns a
 * record without one. That is exactly what the keychain-backed
 * localStorage store returns in the Tauri runtime, and the caller
 * (`agent-service.ts`) already knows how to fetch the key from the
 * keychain.
 */
export class DatabaseProfileStore implements ProfileStore {
  private db: Promise<KindoraDatabase> | null = null;

  constructor(private readonly provider: DatabaseProvider) {}

  private async database(): Promise<KindoraDatabase> {
    if (!this.db) this.db = this.provider();
    return this.db;
  }

  async loadAgent(): Promise<StoredAgent | null> {
    const db = await this.database();
    const agent = await db.getAgent();
    if (!agent) return null;
    // Normalise for the same reason the localStorage store does: a
    // record written before Phase B has no field-level gates, and a
    // caller must never see `undefined` where a gate belongs.
    return normaliseStoredAgent(agent);
  }

  async saveAgent(agent: StoredAgent): Promise<void> {
    const db = await this.database();
    await db.saveAgent(agent);
  }

  async deleteAgent(): Promise<void> {
    const db = await this.database();
    await db.deleteAgent();
  }

  async loadProfile(): Promise<SocialProfile | null> {
    const db = await this.database();
    const agent = await db.getAgent();
    return agent?.profile ?? null;
  }

  async saveProfile(profile: SocialProfile): Promise<void> {
    const db = await this.database();
    const existing = await db.getAgent();
    if (!existing) {
      throw new Error('Cannot save profile: no agent exists yet. Call saveAgent first.');
    }
    await db.saveAgent({
      ...existing,
      profile,
      updatedAt: new Date().toISOString(),
    });
  }
}

/** The settings store, backed by the database. */
export class DatabaseSettingsStore implements SettingsStore {
  private db: Promise<KindoraDatabase> | null = null;

  constructor(private readonly provider: DatabaseProvider) {}

  private async database(): Promise<KindoraDatabase> {
    if (!this.db) this.db = this.provider();
    return this.db;
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.database();
    return db.getSetting<T>(key);
  }

  async set<T>(key: string, value: T): Promise<void> {
    const db = await this.database();
    await db.setSetting(key, value);
  }

  async delete(key: string): Promise<void> {
    const db = await this.database();
    await db.deleteSetting(key);
  }
}

/** The block-list store, backed by the database. */
export class DatabaseBlockedAgentsStore implements BlockedAgentsStore {
  private db: Promise<KindoraDatabase> | null = null;

  constructor(private readonly provider: DatabaseProvider) {}

  private async database(): Promise<KindoraDatabase> {
    if (!this.db) this.db = this.provider();
    return this.db;
  }

  async list(): Promise<readonly BlockedAgent[]> {
    const db = await this.database();
    return db.listBlockedAgents();
  }

  async has(agentId: string): Promise<boolean> {
    const db = await this.database();
    return db.isAgentBlocked(agentId);
  }

  async add(agentId: string, reason?: string): Promise<void> {
    const db = await this.database();
    await db.addBlockedAgent(agentId, reason);
  }

  async remove(agentId: string): Promise<void> {
    const db = await this.database();
    await db.removeBlockedAgent(agentId);
  }

  async clear(): Promise<void> {
    const db = await this.database();
    await db.clearBlockedAgents();
  }
}
