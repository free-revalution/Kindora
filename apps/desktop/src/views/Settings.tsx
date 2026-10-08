/**
 * Settings — LLM provider configuration.
 *
 * 开发手册.md § 10–12, § 46.
 */

import { useEffect, useState } from 'react';
import type { LLMProviderKind } from '@kindora/llm';
import {
  PROVIDER_PRESETS,
  presetFor,
  loadLLMConfig,
  saveLLMConfig,
  testConnection,
} from '../lib/llm-service';

export interface SettingsProps {
  onClose: () => void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; reply: string }
  | { kind: 'error'; message: string };

export function Settings({ onClose }: SettingsProps) {
  const [provider, setProvider] = useState<LLMProviderKind>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState<string>(PROVIDER_PRESETS[0]?.defaultBaseUrl ?? '');
  const [model, setModel] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from disk on mount.
  useEffect(() => {
    void loadLLMConfig().then((cfg) => {
      if (cfg) {
        setProvider(cfg.provider);
        setBaseUrl(cfg.baseUrl ?? presetFor(cfg.provider).defaultBaseUrl);
        setModel(cfg.model);
      } else {
        const preset = presetFor(provider);
        setBaseUrl(preset.defaultBaseUrl);
        setModel(preset.exampleModels[0] ?? '');
      }
      setHydrated(true);
    });
  }, [provider]);

  const preset = presetFor(provider);
  const needsKey = preset.requiresApiKey;
  const canSave = model.trim().length > 0 && baseUrl.trim().length > 0 && !saving;

  function switchProvider(next: LLMProviderKind) {
    setProvider(next);
    const nextPreset = presetFor(next);
    setBaseUrl(nextPreset.defaultBaseUrl);
    setModel(nextPreset.exampleModels[0] ?? '');
    setApiKey('');
    setHasExistingKey(false);
    setTest({ kind: 'idle' });
  }

  async function handleSave() {
    setSaving(true);
    setTest({ kind: 'idle' });
    try {
      await saveLLMConfig({ provider, baseUrl, model }, needsKey ? apiKey : undefined);
      if (needsKey && apiKey.length > 0) setHasExistingKey(true);
      setApiKey('');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!canSave) return;
    setTest({ kind: 'testing' });
    try {
      const reply = await testConnection(
        { provider, baseUrl, model },
        needsKey ? apiKey : undefined,
      );
      setTest({ kind: 'ok', reply: reply.trim() });
    } catch (err) {
      setTest({ kind: 'error', message: (err as Error).message });
    }
  }

  if (!hydrated) {
    return (
      <main className="text-kindora-500 flex h-full items-center justify-center text-sm">
        Loading settings…
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <button type="button" className="kindora-button-ghost" onClick={onClose}>
          Done
        </button>
      </header>

      <section className="kindora-card flex flex-col gap-4">
        <h2 className="text-base font-semibold">LLM Provider</h2>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Provider</span>
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
          <span className="text-sm font-medium">Base URL</span>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="kindora-input font-mono text-xs"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Model</span>
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
            Suggestions: {preset.exampleModels.join(', ')}
          </span>
        </label>

        {needsKey && (
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="kindora-input font-mono text-xs"
              placeholder={hasExistingKey ? '•••••••• (saved) — enter to replace' : 'sk-…'}
              autoComplete="off"
              spellCheck={false}
            />
            <span className="text-kindora-500 dark:text-kindora-400 text-xs">
              Stored locally only — encrypted at rest (browser dev) or in OS keychain (Tauri).
            </span>
          </label>
        )}

        <div className="border-kindora-100 dark:border-kindora-800 flex items-center justify-between border-t pt-4">
          <button
            type="button"
            className="kindora-button-ghost"
            onClick={handleTest}
            disabled={!canSave || test.kind === 'testing'}
          >
            {test.kind === 'testing' ? 'Testing…' : 'Test Connection'}
          </button>
          <button type="button" className="kindora-button" onClick={handleSave} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        {test.kind === 'ok' && (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200">
            ✓ Connection OK. Model replied: <code>{test.reply}</code>
          </p>
        )}
        {test.kind === 'error' && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/40 dark:text-red-200">
            ✗ {test.message}
          </p>
        )}
      </section>

      <p className="text-kindora-500 dark:text-kindora-400 text-center text-xs">
        Kindora never sends your API key to another agent, logs it, or includes it in your profile.
      </p>
    </main>
  );
}
