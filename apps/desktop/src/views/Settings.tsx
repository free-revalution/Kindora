/**
 * Settings — LLM provider configuration.
 *
 * 开发手册.md § 10–12, § 46.
 */

import { useEffect, useRef, useState } from 'react';
import type { LLMProviderKind } from '@kindora/llm';
import {
  PROVIDER_PRESETS,
  presetFor,
  loadLLMConfig,
  saveLLMConfig,
  clearStoredApiKey,
  hasStoredApiKey,
  loadStoredApiKey,
  testConnection,
} from '../lib/llm-service';
import { SUPPORTED_LOCALES, useI18n, useTranslate, type Locale } from '../i18n';

export interface SettingsProps {
  onClose: () => void;
  /**
   * Called after a save that actually succeeded.
   *
   * The app caches whether an LLM provider is usable (`llmReady`) and the
   * Connect screen gates on it. Without this callback the cache kept the
   * value it read at startup, so saving an API key appeared to work — the
   * green banner appeared — but the Connect screen kept saying "LLM not
   * configured" until the app was restarted.
   */
  onSaved?: () => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; reply: string }
  | { kind: 'error'; message: string };

/**
 * Save outcome. Without this the only observable effect of a successful save
 * was the API-key input clearing — indistinguishable from a silent failure,
 * and an actual `saveLLMConfig` rejection propagated as an unhandled promise
 * rejection with nothing rendered.
 */
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

/**
 * Outcome of removing the stored key.
 *
 * Separate from `SaveState` so "the key was removed" never renders as
 * "Saved. API key stored locally." — the two are opposites.
 */
type ClearState =
  | { kind: 'idle' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

/** Provider selected before any saved config is known. */
const DEFAULT_PROVIDER: LLMProviderKind = 'openai-compatible';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function Settings({ onClose, onSaved }: SettingsProps) {
  const t = useTranslate();
  const [provider, setProvider] = useState<LLMProviderKind>(DEFAULT_PROVIDER);
  const [baseUrl, setBaseUrl] = useState<string>(PROVIDER_PRESETS[0]?.defaultBaseUrl ?? '');
  const [model, setModel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [clear, setClear] = useState<ClearState>({ kind: 'idle' });
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [hydrated, setHydrated] = useState(false);

  // Monotonic counter for the "is a key stored?" probe.
  //
  // The probe is asynchronous (it reads the OS keychain), so it can
  // land *after* a save that has already established the truth. Each
  // new probe takes the next number; a probe whose number is no
  // longer the current one is stale and must not write state.
  const probeSeq = useRef(0);

  // Hydrate from disk ONCE on mount.
  //
  // This must NOT depend on `provider`. Re-running it after `switchProvider`
  // would call `loadLLMConfig()` again, get the *previously saved* config, and
  // `setProvider(cfg.provider)` — snapping the select back to the old provider
  // and discarding the user's choice. The effect also reset baseUrl/model, so
  // the key would then be persisted under the wrong provider name.
  useEffect(() => {
    void loadLLMConfig().then((cfg) => {
      if (cfg) {
        setProvider(cfg.provider);
        setBaseUrl(cfg.baseUrl ?? presetFor(cfg.provider).defaultBaseUrl);
        setModel(cfg.model);
      } else {
        const preset = presetFor(DEFAULT_PROVIDER);
        setBaseUrl(preset.defaultBaseUrl);
        setModel(preset.exampleModels[0] ?? '');
      }
      setHydrated(true);
    });
  }, []);

  // Ask the secret store whether a key is already stored for the
  // current provider.
  //
  // This is what makes the field honest across restarts. Without it
  // `hasExistingKey` was only ever set by `handleSave`, so a key saved
  // in a previous session looked like it had never been saved — the
  // placeholder showed the empty "sk-…" instead of "saved". The user
  // then saved again (harmless in itself) and, before this was fixed,
  // that second save *deleted* the stored key.
  //
  // Existence only: the value never leaves the secret store.
  useEffect(() => {
    if (!hydrated) return;
    const seq = ++probeSeq.current;
    let active = true;
    void hasStoredApiKey(provider)
      .then((present) => {
        if (!active || seq !== probeSeq.current) return;
        setHasExistingKey(present);
      })
      .catch(() => {
        if (!active || seq !== probeSeq.current) return;
        setHasExistingKey(false);
      });
    return () => {
      active = false;
    };
  }, [provider, hydrated]);

  const preset = presetFor(provider);
  const needsKey = preset.requiresApiKey;
  const canSave =
    model.trim().length > 0 && baseUrl.trim().length > 0 && save.kind !== 'saving';

  function switchProvider(next: LLMProviderKind) {
    setProvider(next);
    const nextPreset = presetFor(next);
    setBaseUrl(nextPreset.defaultBaseUrl);
    setModel(nextPreset.exampleModels[0] ?? '');
    setApiKey('');
    setHasExistingKey(false);
    setTest({ kind: 'idle' });
    setSave({ kind: 'idle' });
    setClear({ kind: 'idle' });
  }

  async function handleSave() {
    setSave({ kind: 'saving' });
    setTest({ kind: 'idle' });
    setClear({ kind: 'idle' });
    try {
      // An empty field means "keep the key that is already stored".
      // `saveLLMConfig` no longer treats an empty key as a delete —
      // removing a key is an explicit action (`handleClearKey`).
      await saveLLMConfig({ provider, baseUrl, model }, needsKey ? apiKey : undefined);
      // A save that carried a key establishes the truth; invalidate
      // any in-flight probe so it cannot overwrite this.
      if (needsKey && apiKey.length > 0) {
        probeSeq.current += 1;
        setHasExistingKey(true);
      }
      // Only clear the field once the write has actually resolved. Clearing it
      // up front (or in a `finally`) would destroy the user's key on a failed
      // save and leave no way to retry without retyping it.
      setApiKey('');
      setSave({ kind: 'ok' });
      // The config on disk changed — tell the app so it can re-read whether
      // a provider is usable. Without this the Connect screen would keep the
      // "no LLM" state it read at startup.
      onSaved?.();
    } catch (err) {
      setSave({ kind: 'error', message: errorMessage(err) });
    }
  }

  async function handleClearKey() {
    setClear({ kind: 'idle' });
    try {
      await clearStoredApiKey(provider);
      probeSeq.current += 1;
      setHasExistingKey(false);
      setApiKey('');
      setClear({ kind: 'ok' });
      onSaved?.();
    } catch (err) {
      setClear({ kind: 'error', message: errorMessage(err) });
    }
  }

  async function handleTest() {
    if (!canSave) return;
    setTest({ kind: 'testing' });
    setSave({ kind: 'idle' });
    try {
      // An empty field means "use the key that is already stored". A
      // stored key is never displayed, so after a restart the field is
      // empty by design — testing with nothing would report a missing
      // key for a provider that is configured correctly.
      const key = needsKey
        ? apiKey.length > 0
          ? apiKey
          : await loadStoredApiKey(provider)
        : undefined;
      const reply = await testConnection({ provider, baseUrl, model }, key);
      setTest({ kind: 'ok', reply: reply.trim() });
    } catch (err) {
      setTest({ kind: 'error', message: errorMessage(err) });
    }
  }

  if (!hydrated) {
    return (
      <main className="text-kindora-500 flex h-full items-center justify-center text-sm">
        {t('settings.loading')}
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">{t('settings.title')}</h1>
        <button type="button" className="kindora-button-ghost" onClick={onClose}>
          {t('settings.done')}
        </button>
      </header>

      <LanguagePicker />

      <section className="kindora-card flex flex-col gap-4">
        <h2 className="text-base font-semibold">{t('settings.llmProvider')}</h2>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('settings.provider')}</span>
          <select
            value={provider}
            onChange={(e) => switchProvider(e.target.value as LLMProviderKind)}
            className="kindora-input"
          >
            {PROVIDER_PRESETS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('settings.baseUrl')}</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="kindora-input font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">{t('settings.model')}</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="kindora-input font-mono text-xs"
            list="model-suggestions"
            placeholder={preset.exampleModels[0]}
          />
          <datalist id="model-suggestions">
            {preset.exampleModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="text-kindora-500 dark:text-kindora-400 text-xs">
            {t('settings.suggestions', { models: preset.exampleModels.join(', ') })}
          </span>
        </label>

        {needsKey && (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">{t('settings.apiKey')}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="kindora-input font-mono text-xs"
              placeholder={
                hasExistingKey
                  ? t('settings.apiKeyPlaceholderSaved')
                  : t('settings.apiKeyPlaceholderEmpty')
              }
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-kindora-500 dark:text-kindora-400 text-xs">
              {t('settings.apiKeyStorageNote')}
            </span>
          </label>
        )}

        {needsKey && hasExistingKey && (
          <div className="flex flex-col items-start gap-1">
            {/* The field itself is empty on purpose — a stored key is
                never rendered, not even masked-and-decoded. This line
                is the honest answer to "is my key there?": without it
                the empty field reads as "nothing was saved", and the
                user saves again (which used to delete the key). */}
            <p className="text-xs text-emerald-700 dark:text-emerald-200">
              ✓ {t('settings.apiKeyStoredNote')}
            </p>
            <button
              type="button"
              className="kindora-button-ghost text-xs"
              onClick={() => {
                void handleClearKey();
              }}
            >
              {t('settings.apiKeyClear')}
            </button>
            {clear.kind === 'ok' && (
              <p className="text-xs text-emerald-700 dark:text-emerald-200">
                ✓ {t('settings.apiKeyCleared')}
              </p>
            )}
            {clear.kind === 'error' && (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                ✗ {t('settings.apiKeyClearFailed', { message: clear.message })}
              </p>
            )}
          </div>
        )}

        <div className="border-kindora-100 dark:border-kindora-800 flex items-center justify-between border-t pt-4">
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={handleTest}
            disabled={!canSave || test.kind === 'testing'}
          >
            {test.kind === 'testing' ? t('settings.testing') : t('settings.testConnection')}
          </button>
          <button type="button" className="kindora-button" onClick={handleSave} disabled={!canSave}>
            {save.kind === 'saving' ? t('common.saving') : t('settings.save')}
          </button>
        </div>

        {save.kind === 'ok' && (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
            ✓{' '}
            {t(
              needsKey && hasExistingKey
                ? 'settings.saveSuccessWithKey'
                : 'settings.saveSuccessSettings',
            )}
          </p>
        )}
        {save.kind === 'error' && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-200">
            ✗ {t('settings.saveFailure', { message: save.message })}
          </p>
        )}

        {test.kind === 'ok' && (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
            ✓ {t('settings.connectionOk')} <code>{test.reply}</code>
          </p>
        )}
        {test.kind === 'error' && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-200">
            ✗ {test.message}
          </p>
        )}
      </section>

      <p className="text-kindora-500 dark:text-kindora-400 text-center text-xs">
        {t('settings.privacyNote')}
      </p>
    </main>
  );
}

/**
 * Language switcher.
 *
 * Options are rendered from `SUPPORTED_LOCALES`, so adding a dictionary file is
 * all it takes for the language to appear here — no edit to this component. The
 * labels are endonyms (`简体中文`, `English`), never translated, because
 * someone who cannot read the current UI language still has to be able to find
 * their own.
 */
function LanguagePicker() {
  const { locale, setLocale, t } = useI18n();
  return (
    <section className="kindora-card flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('settings.language')}</span>
        <select
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
          className="kindora-input"
          data-testid="language-select"
        >
          {SUPPORTED_LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.endonym}
            </option>
          ))}
        </select>
      </label>
      <span className="text-kindora-500 dark:text-kindora-400 text-xs">
        {t('settings.languageHint')}
      </span>
    </section>
  );
}
