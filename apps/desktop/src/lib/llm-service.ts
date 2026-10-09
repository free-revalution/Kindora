/**
 * LLM service — bridges the configured LLM with SecretStore + SettingsStore.
 *
 * Persists:
 *   - API key in SecretStore (under key 'llm:<provider>:api-key')
 *   - Provider / model / baseUrl in SettingsStore (key 'llmConfig')
 *
 * See 开发手册.md § 10–12.
 */

import type { LLMConfig, LLMProvider, LLMProviderKind } from '@kindora/llm';
import { createProvider } from '@kindora/llm';
import {
  BrowserLocalStorageEncryptedSecretStore,
  BrowserLocalStorageSettingsStore,
  type SecretStore,
  type SettingsStore,
} from '@kindora/storage';

const SETTINGS_KEY = 'llmConfig';
const secretKeyFor = (provider: LLMProviderKind): string => `llm:${provider}:api-key`;

const _settings: SettingsStore = new BrowserLocalStorageSettingsStore();
const _secrets: SecretStore = new BrowserLocalStorageEncryptedSecretStore();

export function getSettingsStore(): SettingsStore {
  return _settings;
}

export function getSecretStore(): SecretStore {
  return _secrets;
}

/**
 * Public LLM config (no API key). Safe to log / inspect.
 */
export interface StoredLLMConfig {
  provider: LLMProviderKind;
  model: string;
  baseUrl?: string;
}

export async function loadLLMConfig(): Promise<StoredLLMConfig | null> {
  return _settings.get<StoredLLMConfig>(SETTINGS_KEY);
}

export async function saveLLMConfig(config: StoredLLMConfig, apiKey?: string): Promise<void> {
  await _settings.set(SETTINGS_KEY, config);
  if (apiKey !== undefined) {
    if (apiKey === '') {
      await _secrets.delete(secretKeyFor(config.provider));
    } else {
      await _secrets.set(secretKeyFor(config.provider), apiKey);
    }
  }
}

export async function clearLLMConfig(): Promise<void> {
  await _settings.delete(SETTINGS_KEY);
  for (const provider of ['openai-compatible', 'anthropic', 'ollama', 'minimax'] as const) {
    await _secrets.delete(secretKeyFor(provider));
  }
}

/**
 * Build a working `LLMProvider` from the persisted config + stored key.
 * Returns null when no config has been saved yet.
 */
export async function loadProvider(): Promise<LLMProvider | null> {
  const cfg = await loadLLMConfig();
  if (!cfg) return null;
  const apiKey =
    cfg.provider === 'ollama' ? undefined : await _secrets.get(secretKeyFor(cfg.provider));
  return createProvider({ ...cfg, apiKey: apiKey ?? undefined });
}

export async function testConnection(cfg: StoredLLMConfig, apiKey?: string): Promise<string> {
  const provider = createProvider({
    ...cfg,
    apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
  });
  const reply = await provider.chat(
    [
      {
        role: 'system',
        content: 'Reply with exactly the word "ok" and nothing else.',
      },
      { role: 'user', content: 'ping' },
    ],
    { maxTokens: 8, temperature: 0 },
  );
  return reply.content;
}

/* ------------------------------------------------------------------ */
/* Catalogue — drives the Settings form                                */
/* ------------------------------------------------------------------ */

export interface ProviderPreset {
  readonly kind: LLMProviderKind;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly exampleModels: readonly string[];
  readonly requiresApiKey: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    exampleModels: ['gpt-4o-mini', 'deepseek-chat', 'qwen-turbo', 'doubao-pro'],
    requiresApiKey: true,
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    exampleModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    requiresApiKey: true,
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    defaultBaseUrl: 'http://localhost:11434',
    exampleModels: ['llama3.1', 'mistral', 'qwen2.5'],
    requiresApiKey: false,
  },
  {
    kind: 'minimax',
    label: 'MiniMax',
    defaultBaseUrl: 'https://api.minimaxi.com/v1',
    exampleModels: ['MiniMax-M3'],
    requiresApiKey: true,
  },
];

export function presetFor(kind: LLMProviderKind): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.kind === kind);
  if (!preset) throw new Error(`Unknown provider: ${kind}`);
  return preset;
}

/**
 * Re-export the protocol-typed `LLMConfig` so callers don't need to
 * reach into `@kindora/llm` themselves when constructing one.
 */
export type { LLMConfig };
