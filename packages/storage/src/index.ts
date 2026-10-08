/**
 * @kindora/storage
 *
 * Local SQLite persistence.
 * Phase 0: schema declaration + abstract interface only.
 * Concrete driver lands in Phase 1.
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

export interface StorageBackend {
  initialize(): Promise<void>;
  read(table: StorageTable, key: string): Promise<unknown | null>;
  write(table: StorageTable, key: string, value: unknown): Promise<void>;
  delete(table: StorageTable, key: string): Promise<void>;
  list(table: StorageTable): Promise<readonly unknown[]>;
}

export const STORAGE_PACKAGE_VERSION = '0.1.0';
