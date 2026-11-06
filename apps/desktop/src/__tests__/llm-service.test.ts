import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLLMConfig,
  clearStoredApiKey,
  hasStoredApiKey,
  loadLLMConfig,
  loadProvider,
  saveLLMConfig,
  testConnection,
} from '../lib/llm-service';

beforeEach(() => {
  localStorage.clear();
});

describe('apps/desktop — llm-service persistence', () => {
  it('returns null before any save', async () => {
    expect(await loadLLMConfig()).toBeNull();
    expect(await loadProvider()).toBeNull();
  });

  it('saves and reloads LLM config (provider + model + baseUrl)', async () => {
    await saveLLMConfig({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });

    const cfg = await loadLLMConfig();
    expect(cfg).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
  });

  it('stores the API key in SecretStore, not in SettingsStore', async () => {
    await saveLLMConfig(
      { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'x' },
      'sk-very-secret-12345',
    );

    const settingsRaw = localStorage.getItem('kindora:settings:llmConfig');
    expect(settingsRaw).not.toBeNull();
    expect(settingsRaw).not.toContain('sk-very-secret');

    const secretRaw = localStorage.getItem('kindora:secret:llm:openai-compatible:api-key');
    expect(secretRaw).not.toBeNull();
    expect(secretRaw).not.toContain('sk-very-secret');
  });

  it('loadProvider returns a working provider after save', async () => {
    await saveLLMConfig(
      { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'x' },
      'sk-test',
    );
    const provider = await loadProvider();
    expect(provider).not.toBeNull();
    expect(typeof provider!.chat).toBe('function');
  });

  it('loadProvider returns null — not a throw — when the saved provider has no API key', async () => {
    // A config whose key is missing is "not configured yet", not a crash. It is
    // exactly the state a failed keychain write leaves behind, and `App` calls
    // `loadProvider()` on every startup: throwing here turned a half-configured
    // app into an unhandled rejection before the UI could say anything.
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    await expect(loadProvider()).resolves.toBeNull();
  });

  it('loadProvider still builds a provider for a keyless provider (Ollama)', async () => {
    await saveLLMConfig({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });
    const provider = await loadProvider();
    expect(provider).not.toBeNull();
  });

  it('clearLLMConfig wipes everything', async () => {
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'sk-ant');
    await clearLLMConfig();
    expect(await loadLLMConfig()).toBeNull();
    expect(localStorage.getItem('kindora:settings:llmConfig')).toBeNull();
    expect(localStorage.getItem('kindora:secret:llm:anthropic:api-key')).toBeNull();
  });

  it('saveLLMConfig with an empty API key keeps the stored key', async () => {
    // The Settings screen passes the *live input value*, which is empty
    // whenever the user has not typed a new key this session. Treating
    // that as "delete" silently wiped a key that was already stored —
    // the user re-saved an unchanged provider and lost the key. An empty
    // key now means "leave the stored key alone".
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'sk-ant');
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, '');
    expect(localStorage.getItem('kindora:secret:llm:anthropic:api-key')).not.toBeNull();
    expect(await hasStoredApiKey('anthropic')).toBe(true);
  });

  it('clearStoredApiKey removes the stored key', async () => {
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'sk-ant');
    expect(await hasStoredApiKey('anthropic')).toBe(true);
    await clearStoredApiKey('anthropic');
    expect(localStorage.getItem('kindora:secret:llm:anthropic:api-key')).toBeNull();
    expect(await hasStoredApiKey('anthropic')).toBe(false);
  });

  it('hasStoredApiKey reports existence per provider, without revealing the key', async () => {
    expect(await hasStoredApiKey('anthropic')).toBe(false);
    await saveLLMConfig({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, 'sk-ant-secret');
    expect(await hasStoredApiKey('anthropic')).toBe(true);
    // A different provider has its own keyspace.
    expect(await hasStoredApiKey('openai-compatible')).toBe(false);
    // A provider that needs no key never has one.
    expect(await hasStoredApiKey('ollama')).toBe(false);
  });
});

describe('apps/desktop — testConnection', () => {
  it('returns the model reply on a successful round-trip', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const reply = await testConnection(
      { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm' },
      'sk-test',
    );
    expect(reply).toBe('ok');
    expect(spy).toHaveBeenCalledTimes(1);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
  });

  it('propagates API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'nope' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      testConnection(
        { provider: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'm' },
        'bad',
      ),
    ).rejects.toThrow(/invalid api key/i);
  });
});
