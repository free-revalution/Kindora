/**
 * @kindora/storage
 *
 * Local-first persistence for profile, conversations, settings.
 * Phase 1: ProfileStore interface + BrowserLocalStorage implementation.
 * Phase 2+: SQLite backend (better-sqlite3 / tauri-plugin-sql).
 *
 * See 开发手册.md § 37.
 */

export const STORAGE_TABLES = [
  'profiles',
  'agents',
  'llm_configs',
  'connections',
  'matches',
  'conversations',
  'messages',
  'permissions',
] as const;

export type StorageTable = (typeof STORAGE_TABLES)[number];

/**
 * Generic CRUD interface for raw rows.
 * Phase 2+ concrete implementations: SQLite, IndexedDB, etc.
 */
export interface StorageBackend {
  initialize(): Promise<void>;
  read(table: StorageTable, key: string): Promise<unknown | null>;
  write(table: StorageTable, key: string, value: unknown): Promise<void>;
  delete(table: StorageTable, key: string): Promise<void>;
  list(table: StorageTable): Promise<readonly unknown[]>;
}

export const STORAGE_PACKAGE_VERSION = '0.1.0';

export { type StoredAgent, type ProfileStore, PROFILE_STORE_VERSION } from './profile-store';

export { BrowserLocalStorageProfileStore } from './browser-store';
