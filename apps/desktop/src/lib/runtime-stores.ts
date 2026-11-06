/**
 * The stores this runtime uses — Phase D / D1.
 *
 * The app has exactly three persistent stores: the profile, the
 * settings and the block list. Each one had a single implementation —
 * the localStorage one. This module picks the implementation that
 * matches the runtime:
 *
 *   - **the desktop app** → the local business database (SQLite);
 *   - **the browser dev server** → localStorage, because there is no
 *     Tauri runtime and therefore no database file.
 *
 * The choice is made **once**, at module load, so that a store never
 * changes identity half-way through a session.
 *
 * The two runtimes keep separate data anyway: a browser's
 * `localStorage` and the Tauri webview's `localStorage` are different
 * origins, so the dev server and the packaged app never see each
 * other's data.
 */

import {
  BrowserLocalStorageBlockedAgentsStore,
  BrowserLocalStorageProfileStore,
  BrowserLocalStorageSettingsStore,
  DatabaseBlockedAgentsStore,
  DatabaseProfileStore,
  DatabaseSettingsStore,
  type BlockedAgentsStore,
  type ProfileStore,
  type SettingsStore,
} from '@kindora/storage';

import { getKindoraDatabase, isDatabaseAvailable } from './database';

let _profileStore: ProfileStore | null = null;
let _settingsStore: SettingsStore | null = null;
let _blockedAgentsStore: BlockedAgentsStore | null = null;

/** The profile store — the local database when there is one. */
export function runtimeProfileStore(): ProfileStore {
  if (!_profileStore) {
    _profileStore = isDatabaseAvailable()
      ? new DatabaseProfileStore(() => getKindoraDatabase())
      : new BrowserLocalStorageProfileStore();
  }
  return _profileStore;
}

/** The settings store — the local database when there is one. */
export function runtimeSettingsStore(): SettingsStore {
  if (!_settingsStore) {
    _settingsStore = isDatabaseAvailable()
      ? new DatabaseSettingsStore(() => getKindoraDatabase())
      : new BrowserLocalStorageSettingsStore();
  }
  return _settingsStore;
}

/** The block-list store — the local database when there is one. */
export function runtimeBlockedAgentsStore(): BlockedAgentsStore {
  if (!_blockedAgentsStore) {
    _blockedAgentsStore = isDatabaseAvailable()
      ? new DatabaseBlockedAgentsStore(() => getKindoraDatabase())
      : new BrowserLocalStorageBlockedAgentsStore();
  }
  return _blockedAgentsStore;
}
