/**
 * Vitest tests for the TauriSecretStore — the OS keychain shim.
 *
 * Strategy: stub the Tauri runtime in `window.__TAURI_INTERNALS__` and
 * drive the TauriSecretStore through a mock backend that records
 * each call. We do NOT exercise the real keyring crate (that lives in
 * Rust; covered by the cross-process `kindora_desktop` Tauri build
 * when run in CI on macOS / Windows / Linux).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TauriSecretStore, isTauriSecretStoreAvailable } from '../lib/tauri-secret-store';

interface CallRecord {
  cmd: string;
  args?: Record<string, unknown>;
}

interface MockState {
  records: CallRecord[];
  store: Map<string, string>;
  failOn?: string;
}

function installTauriMock(state: MockState) {
  const w = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
  w.__TAURI_INTERNALS__ = {
    async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      state.records.push({ cmd, args });
      if (state.failOn === cmd) throw new Error(`mock-fail: ${cmd}`);
      switch (cmd) {
        case 'secret_set':
          state.store.set(String(args?.key ?? ''), String(args?.value ?? ''));
          return null;
        case 'secret_get':
          return state.store.get(String(args?.key ?? '')) ?? null;
        case 'secret_delete': {
          const k = String(args?.key ?? '');
          state.store.delete(k);
          return null;
        }
        case 'secret_list':
          return [...state.store.keys()];
        default:
          throw new Error(`unknown mock command: ${cmd}`);
      }
    },
  };
}

describe('TauriSecretStore', () => {
  let state: MockState;
  beforeEach(() => {
    state = { records: [], store: new Map() };
    installTauriMock(state);
  });

  afterEach(() => {
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    delete w.__TAURI_INTERNALS__;
  });

  it('reports availability based on the Tauri runtime', () => {
    expect(isTauriSecretStoreAvailable()).toBe(true);
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    delete w.__TAURI_INTERNALS__;
    expect(isTauriSecretStoreAvailable()).toBe(false);
    installTauriMock(state);
  });

  it('round-trips a value', async () => {
    const s = new TauriSecretStore();
    await s.set('llm:openai-compatible:api-key', 'sk-test-1234');
    expect(state.records.length).toBe(1);
    expect(state.records[0]?.cmd).toBe('secret_set');
    const v = await s.get('llm:openai-compatible:api-key');
    expect(v).toBe('sk-test-1234');
    expect(state.records[1]?.cmd).toBe('secret_get');
  });

  it('returns null for missing key', async () => {
    const s = new TauriSecretStore();
    const v = await s.get('llm:nonexistent:api-key');
    expect(v).toBeNull();
  });

  it('delete removes a value', async () => {
    const s = new TauriSecretStore();
    await s.set('llm:a', 'k');
    await s.delete('llm:a');
    const v = await s.get('llm:a');
    expect(v).toBeNull();
  });

  it('throws when the Tauri runtime is missing', () => {
    const w = window as Window & { __TAURI_INTERNALS__?: unknown };
    delete w.__TAURI_INTERNALS__;
    expect(() => new TauriSecretStore()).toThrow(/Tauri runtime/);
    installTauriMock(state);
  });

  it('propagates errors from the Tauri command', async () => {
    state.failOn = 'secret_get';
    const s = new TauriSecretStore();
    await expect(s.get('llm:fail:api-key')).rejects.toThrow(/mock-fail/);
  });
});
