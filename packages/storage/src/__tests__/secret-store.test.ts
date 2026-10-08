import { describe, it, expect, beforeEach } from 'vitest';
import {
  BrowserLocalStorageEncryptedSecretStore,
  BrowserLocalStorageSettingsStore,
  InMemorySecretStore,
} from '../index';

beforeEach(() => {
  localStorage.clear();
});

describe('InMemorySecretStore', () => {
  it('round-trips a secret', async () => {
    const store = new InMemorySecretStore();
    expect(await store.get('x')).toBeNull();
    await store.set('x', 'hello');
    expect(await store.get('x')).toBe('hello');
    await store.delete('x');
    expect(await store.get('x')).toBeNull();
  });
});

describe('BrowserLocalStorageEncryptedSecretStore', () => {
  it('round-trips a secret and persists across instances', async () => {
    const a = new BrowserLocalStorageEncryptedSecretStore();
    await a.set('openai', 'sk-abc123');
    const b = new BrowserLocalStorageEncryptedSecretStore();
    expect(await b.get('openai')).toBe('sk-abc123');
  });

  it('never writes plaintext to localStorage', async () => {
    const store = new BrowserLocalStorageEncryptedSecretStore();
    const secret = 'sk-super-secret-12345';
    await store.set('openai', secret);
    const raw = localStorage.getItem('kindora:secret:openai');
    expect(raw).not.toBeNull();
    expect(raw).not.toContain(secret);
  });

  it('returns null for missing key', async () => {
    const store = new BrowserLocalStorageEncryptedSecretStore();
    expect(await store.get('missing')).toBeNull();
  });

  it('returns null on corrupt ciphertext instead of throwing', async () => {
    localStorage.setItem('kindora:secret:openai', 'not-a-valid-iv:or-ciphertext');
    const store = new BrowserLocalStorageEncryptedSecretStore();
    expect(await store.get('openai')).toBeNull();
  });

  it('delete removes the key', async () => {
    const store = new BrowserLocalStorageEncryptedSecretStore();
    await store.set('k', 'v');
    await store.delete('k');
    expect(await store.get('k')).toBeNull();
  });
});

describe('BrowserLocalStorageSettingsStore', () => {
  it('round-trips typed values', async () => {
    const store = new BrowserLocalStorageSettingsStore();
    expect(await store.get('llmConfig')).toBeNull();
    const cfg = {
      provider: 'openai-compatible' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    };
    await store.set('llmConfig', cfg);
    const loaded = await store.get<typeof cfg>('llmConfig');
    expect(loaded).toEqual(cfg);
  });

  it('delete removes the key', async () => {
    const store = new BrowserLocalStorageSettingsStore();
    await store.set('x', { foo: 1 });
    await store.delete('x');
    expect(await store.get('x')).toBeNull();
  });

  it('returns null on corrupt JSON', async () => {
    localStorage.setItem('kindora:settings:x', 'not-json');
    const store = new BrowserLocalStorageSettingsStore();
    expect(await store.get('x')).toBeNull();
  });
});
