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
import { TauriSecretStore, isTauriSecretStoreAvailable } from './tauri-secret-store';

const SETTINGS_KEY = 'llmConfig';
const secretKeyFor = (provider: LLMProviderKind): string => `llm:${provider}:api-key`;

const _settings: SettingsStore = new BrowserLocalStorageSettingsStore();

// V0.1: prefer the TauriSecretStore (OS keychain) when running in a
// Tauri webview. Fall back to the browser-local encrypted store for
// `pnpm dev` (no Tauri runtime). Either way the keyspace is the same.
const _secrets: SecretStore = isTauriSecretStoreAvailable()
  ? new TauriSecretStore()
  : new BrowserLocalStorageEncryptedSecretStore();

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
  // Secret FIRST, settings second.
  //
  // These are two independent writes (localStorage and the OS keychain) and
  // only the first can realistically fail — a locked keychain, a denied
  // `secret_set` invoke, a corrupted `crypto.subtle` context. Writing the
  // settings first would leave the app pointing at a provider whose key was
  // never stored: every later `loadProvider()` builds a provider with
  // `apiKey: undefined` and each request fails at the far end with an opaque
  // 401, with nothing in Settings explaining why. Ordering it this way makes
  // a failure atomic from the caller's point of view — a rejected `saveLLMConfig`
  // means neither half was written, and `handleSave` can surface the real error.
  //
  // An empty (or omitted) key means "leave the stored key alone" — it does
  // NOT delete it. The Settings screen passes the *live input value*, which
  // is empty whenever the user has not typed a new key this session. Treating
  // empty as "delete" meant that re-saving an unchanged provider silently
  // wiped the key that was already in the keychain: the field looked empty
  // (it never showed the stored key), so the user saved again, and the app
  // ended up configured against a key that no longer existed. Deleting is now
  // an explicit, separate action — see `clearStoredApiKey`.
  if (apiKey !== undefined && apiKey.length > 0) {
    await _secrets.set(secretKeyFor(config.provider), apiKey);
  }
  await _settings.set(SETTINGS_KEY, config);
}

/**
 * Remove the stored API key for a provider.
 *
 * Separate from `saveLLMConfig` on purpose: wiping a key must be
 * something the user asked for, not a side effect of saving an
 * unchanged configuration.
 */
export async function clearStoredApiKey(provider: LLMProviderKind): Promise<void> {
  await _secrets.delete(secretKeyFor(provider));
}

/**
 * The stored API key for a provider, or `undefined` when there is none.
 *
 * The Settings screen needs this for "Test Connection": the field is
 * empty after a restart (a stored key is never displayed), so the
 * button has to fall back to the stored key or it would report a
 * missing key for a provider that is configured correctly.
 *
 * The value is returned only to be handed straight back to the
 * provider — it is never rendered and never logged.
 */
export async function loadStoredApiKey(provider: LLMProviderKind): Promise<string | undefined> {
  if (!providerRequiresApiKey(provider)) return undefined;
  try {
    const value = await _secrets.get(secretKeyFor(provider));
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is an API key already stored for this provider?
 *
 * Existence only — the value never leaves the secret store, and this
 * function never returns it. The Settings screen needs it to say "a key
 * is already saved" instead of showing an empty field that looks like
 * the key was never stored.
 *
 * A provider that needs no key (Ollama) never has one.
 */
export async function hasStoredApiKey(provider: LLMProviderKind): Promise<boolean> {
  if (!providerRequiresApiKey(provider)) return false;
  try {
    const value = await _secrets.get(secretKeyFor(provider));
    return typeof value === 'string' && value.length > 0;
  } catch {
    // A locked keychain or a missing entry both mean the same thing
    // to the user: there is no key they can rely on. The real error is
    // surfaced by the next save, which reports it.
    return false;
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
 *
 * Returns null when no config has been saved yet — and also when a config
 * exists but cannot produce a usable provider yet, i.e. the provider needs an
 * API key and none is in the store. That second case is a *normal*
 * "not configured yet" state, not an error: it is exactly what a failed
 * keychain write leaves behind (settings written, secret missing), and it is
 * what a user sees between typing a key and pressing Save.
 *
 * Keeping this total matters: every caller already treats `null` as "the user
 * has not finished configuring the LLM" and shows them a message. Throwing
 * instead would turn a half-configured app into an unhandled rejection at
 * startup (see `App.tsx`) and a confusing failure inside the Connect flow.
 */
export async function loadProvider(): Promise<LLMProvider | null> {
  const cfg = await loadLLMConfig();
  if (!cfg) return null;
  const apiKey = await loadStoredApiKey(cfg.provider);
  if (providerRequiresApiKey(cfg.provider) && !apiKey) return null;
  try {
    return createProvider({ ...cfg, apiKey });
  } catch {
    // A config that cannot even be turned into a provider is the same
    // "not usable" state as a missing key — see `loadLlmStatus`.
    return null;
  }
}

/**
 * Why the app cannot build an LLM provider — or that it can.
 *
 * `loadProvider()` collapses every unusable state into `null`, which is right
 * for the call sites but terrible for the user: the Connect screen showed one
 * generic "LLM not configured" banner, so somebody who had *just* saved an API
 * key had no way to tell "you never configured one" from "your key never
 * reached the keychain". These are different problems with different fixes.
 */
export type LlmUnavailableReason =
  /** No provider has ever been saved. */
  | 'not_configured'
  /** A provider is saved, but its API key is not in the secret store. */
  | 'missing_api_key'
  /** A provider is saved but cannot be constructed (e.g. no baseUrl). */
  | 'invalid_config';

export interface LlmStatus {
  /** True when a provider could be built. */
  readonly ready: boolean;
  /** Set only when `ready` is false. */
  readonly reason?: LlmUnavailableReason;
}

/**
 * Diagnose the saved LLM configuration.
 *
 * Never throws: a broken config is a state to report, not an exception to
 * propagate into the render path.
 */
export async function loadLlmStatus(): Promise<LlmStatus> {
  const cfg = await loadLLMConfig();
  if (!cfg) return { ready: false, reason: 'not_configured' };
  // `loadStoredApiKey` swallows a failing keychain read and answers
  // "no key". A locked or unavailable keychain is indistinguishable
  // from "no key" here — and both mean the app cannot talk to the
  // provider, so reporting `missing_api_key` is the honest answer.
  const apiKey = await loadStoredApiKey(cfg.provider);
  if (providerRequiresApiKey(cfg.provider) && !apiKey) {
    return { ready: false, reason: 'missing_api_key' };
  }
  try {
    createProvider({ ...cfg, apiKey });
  } catch {
    return { ready: false, reason: 'invalid_config' };
  }
  return { ready: true };
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
 * Does this provider need an API key before it can be used?
 *
 * Unknown providers are treated as requiring one: refusing to build a
 * provider that will fail with an opaque 401 is safer than building one.
 */
function providerRequiresApiKey(kind: LLMProviderKind): boolean {
  return PROVIDER_PRESETS.find((p) => p.kind === kind)?.requiresApiKey ?? true;
}

/**
 * Re-export the protocol-typed `LLMConfig` so callers don't need to
 * reach into `@kindora/llm` themselves when constructing one.
 */
export type { LLMConfig };
