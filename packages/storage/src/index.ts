/**
 * @kindora/storage
 *
 * Local-first persistence for profile, conversations, settings, secrets.
 *
 *   - ProfileStore           Phase 1 — agent + profile
 *   - SecretStore            Phase 2 — API keys
 *   - SettingsStore          Phase 2 — non-secret prefs
 *   - BrowserLocalStorage*   Implementations for browser / Tauri webview
 *
 * Phase 2+: SQLite backend (better-sqlite3 / tauri-plugin-sql) replaces
 * the localStorage layer in Tauri runtime.
 *
 * See 开发手册.md § 12, § 37.
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

export { type SecretStore, SECRET_STORE_VERSION } from './secret-store';
export { InMemorySecretStore } from './in-memory-secret-store';
export { BrowserLocalStorageEncryptedSecretStore } from './encrypted-local-storage-secret-store';

export { type SettingsStore, BrowserLocalStorageSettingsStore } from './settings-store';

export {
  type BlockedAgent,
  type BlockedAgentsStore,
  BrowserLocalStorageBlockedAgentsStore,
  InMemoryBlockedAgentsStore,
} from './blocked-agents-store';
