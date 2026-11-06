/**
 * Internationalisation tests.
 *
 * Two groups:
 *
 *   1. Dictionary integrity — the things a human reviewer cannot catch by
 *      reading the diff: a Chinese string that was left in English, a
 *      placeholder that was dropped in translation, a key that exists in one
 *      dictionary and not the other.
 *
 *   2. Behaviour — the language picker actually switches the UI, the choice
 *      survives a restart, `<html lang>` follows, and the app as a whole (not
 *      just Settings) is translated.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../App';
import { Settings } from '../views/Settings';
import { CreateAgentForm } from '../views/CreateAgentForm';
import { I18nProvider, SUPPORTED_LOCALES, translate } from '../i18n';
import { en } from '../i18n/dictionaries/en';
import { zh } from '../i18n/dictionaries/zh';
import type { Dictionary, TranslationKey } from '../i18n';

/** The key the settings store uses for the chosen language. */
const LOCALE_STORAGE_KEY = 'kindora:settings:uiLocale';

beforeEach(() => {
  localStorage.clear();
  cleanup();
  vi.restoreAllMocks();
  // The provider writes `<html lang>`; jsdom keeps that between tests.
  document.documentElement.lang = '';
});

afterEach(() => {
  cleanup();
});

/* ------------------------------------------------------------------ */
/* 1. Dictionary integrity                                             */
/* ------------------------------------------------------------------ */

describe('apps/desktop — i18n dictionary integrity', () => {
  it('every shipped locale covers exactly the English key set', () => {
    const english = Object.keys(en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      const keys = Object.keys(locale.dictionary).sort();
      const missing = english.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !english.includes(k));
      expect({ locale: locale.code, missing, extra }).toEqual({
        locale: locale.code,
        missing: [],
        extra: [],
      });
    }
  });

  it('every Chinese string is non-empty', () => {
    // A blank label is worse than an English one: the user sees nothing at all
    // and cannot tell that a translation is missing.
    const blank = Object.keys(zh).filter((k) => zh[k as TranslationKey].trim() === '');
    expect(blank).toEqual([]);
  });

  it('every Chinese string keeps the placeholders of its English original', () => {
    // Dropping `{peer}` in translation silently loses the peer's name.
    const placeholders = (s: string): string =>
      [...s.matchAll(/\{(\w+)\}/g)]
        .map((m) => m[1])
        .sort()
        .join(',');

    const mismatched = Object.keys(en).filter(
      (k) => placeholders(en[k as TranslationKey]) !== placeholders(zh[k as TranslationKey]),
    );
    expect(mismatched).toEqual([]);
  });

  it('every Chinese string is actually translated', () => {
    // Deliberately NOT "differs from English" for the whole dictionary: a few
    // strings are technical terms that must stay as they are. They are listed
    // here on purpose, so that any NEW untranslated string fails this test and
    // has to be acknowledged rather than slipped through.
    const intentionallyUntranslated = new Set([
      'settings.apiKey', // "API Key" — the term users recognise
      'settings.apiKeyPlaceholderEmpty', // "sk-…" — a format sample, not prose
      'connect.codePlaceholder', // "ABCDEF" — a sample pairing code
    ]);

    const untranslated = Object.keys(en).filter(
      (k) =>
        en[k as TranslationKey] === zh[k as TranslationKey] && !intentionallyUntranslated.has(k),
    );
    expect(untranslated).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. translate()                                                      */
/* ------------------------------------------------------------------ */

describe('apps/desktop — translate()', () => {
  it('interpolates named parameters', () => {
    expect(translate('en', 'consent.unlockedBody', { peer: 'Ada' })).toContain('Ada');
    expect(translate('zh', 'consent.unlockedBody', { peer: '阿达' })).toContain('阿达');
  });

  it('leaves a placeholder alone when no value is supplied', () => {
    expect(translate('en', 'validation.nickname_too_long')).toContain('{max}');
  });

  it('falls back to English for a key the active dictionary is missing', () => {
    // Unreachable through the type system, which is the point — this is the
    // safety net for a dictionary edited outside TypeScript.
    const key = 'settings.title';
    const original = zh[key];
    delete (zh as Partial<Dictionary>)[key];
    try {
      expect(translate('zh', key)).toBe(en[key]);
    } finally {
      (zh as Dictionary)[key] = original;
    }
  });

  it('falls back to the key itself when no dictionary has it', () => {
    const bogus = 'not.a.real.key' as TranslationKey;
    expect(translate('en', bogus)).toBe('not.a.real.key');
    expect(translate('zh', bogus)).toBe('not.a.real.key');
  });
});

/* ------------------------------------------------------------------ */
/* 3. The language picker                                              */
/* ------------------------------------------------------------------ */

/** The Settings screen, wrapped in a provider the way `App` wraps it. */
function renderSettings(initialLocale?: 'en' | 'zh') {
  return render(
    <I18nProvider initialLocale={initialLocale}>
      <Settings onClose={() => {}} />
    </I18nProvider>,
  );
}

function languageSelect(): HTMLSelectElement {
  return screen.getByTestId('language-select') as HTMLSelectElement;
}

describe('apps/desktop — language switching', () => {
  it('lists every supported language by the name written in that language', async () => {
    renderSettings('en');
    await screen.findByText('Settings');

    const options = [...languageSelect().querySelectorAll('option')].map((o) => ({
      value: o.value,
      label: o.textContent,
    }));
    expect(options).toEqual([
      { value: 'en', label: 'English' },
      { value: 'zh', label: '简体中文' },
    ]);
    // The list is generated from SUPPORTED_LOCALES, so a new dictionary file
    // shows up here without touching the component.
    expect(options).toHaveLength(SUPPORTED_LOCALES.length);
  });

  it('switches the UI immediately, without a restart', async () => {
    renderSettings('en');
    await screen.findByText('Settings');

    await act(async () => {
      fireEvent.change(languageSelect(), { target: { value: 'zh' } });
    });

    expect(await screen.findByText('设置')).toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('persists the choice and restores it on the next launch', async () => {
    const first = renderSettings('en');
    await screen.findByText('Settings');
    await act(async () => {
      fireEvent.change(languageSelect(), { target: { value: 'zh' } });
    });
    await waitFor(() => expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('"zh"'));

    first.unmount();
    cleanup();

    // A fresh mount — this is what the app does on the next start.
    renderSettings();
    expect(await screen.findByText('设置')).toBeInTheDocument();
    expect((languageSelect() as HTMLSelectElement).value).toBe('zh');
  });

  it('keeps <html lang> in sync with the active locale', async () => {
    renderSettings('en');
    await screen.findByText('Settings');
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));

    await act(async () => {
      fireEvent.change(languageSelect(), { target: { value: 'zh' } });
    });
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-Hans'));
  });

  it('translates the whole app, not just the Settings screen', async () => {
    // Seed the persisted choice, then boot the app the way it boots in
    // production: `App` owns the provider, so every screen is covered.
    localStorage.setItem(LOCALE_STORAGE_KEY, JSON.stringify('zh'));
    render(<App />);

    // The Welcome screen is rendered from `App`, three levels away from the
    // provider — if the provider were not wired at the root, this would still
    // be English.
    expect(await screen.findByText('创建我的 Agent')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 4. Localised validation                                             */
/* ------------------------------------------------------------------ */

describe('apps/desktop — localised validation', () => {
  it('shows the validation message in the active language', async () => {
    render(
      <I18nProvider initialLocale="zh">
        <CreateAgentForm variant="create" onSubmit={async () => {}} />
      </I18nProvider>,
    );

    // Nickname is empty on a fresh form.
    expect(await screen.findByText('请填写昵称。')).toBeInTheDocument();
    expect(screen.queryByText('Nickname is required.')).not.toBeInTheDocument();
  });
});
