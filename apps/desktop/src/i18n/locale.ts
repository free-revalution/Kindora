/**
 * Locale registry + persistence.
 *
 * Adding a language is a two-line change here plus one dictionary file:
 *
 *   import { ja } from './dictionaries/ja';
 *   export type Locale = 'en' | 'zh' | 'ja';
 *   const LOCALES = { en: {...}, zh: {...}, ja: {...} };
 *
 * Nothing else needs to know about the new language — views only ever call
 * `t(key)`, and the Settings picker renders `SUPPORTED_LOCALES` directly.
 */

import {
  en,
  type Dictionary,
  type TranslationKey,
  type TranslationParams,
} from './dictionaries/en';
import { zh } from './dictionaries/zh';
import { ensureLegacyMigration } from '../lib/database';
import { runtimeSettingsStore } from '../lib/runtime-stores';

export type { Dictionary, TranslationKey, TranslationParams };

export interface LocaleDescriptor {
  readonly code: Locale;
  /** Name in English — used for sorting/debugging and never shown to the user. */
  readonly englishName: string;
  /**
   * Name written in the language itself. Language pickers show endonyms
   * (`中文`, `English`), not `Chinese`/`English` translated into the current
   * UI language — someone who cannot read the current language still needs to
   * find their own.
   */
  readonly endonym: string;
  /** Value written to `<html lang>`; also the BCP-47 tag for date formatting. */
  readonly htmlLang: string;
  readonly dictionary: Dictionary;
}

export type Locale = 'en' | 'zh';

export const LOCALES: Readonly<Record<Locale, LocaleDescriptor>> = Object.freeze({
  en: {
    code: 'en',
    englishName: 'English',
    endonym: 'English',
    htmlLang: 'en',
    dictionary: en,
  },
  zh: {
    code: 'zh',
    englishName: 'Simplified Chinese',
    endonym: '简体中文',
    htmlLang: 'zh-Hans',
    dictionary: zh,
  },
});

/**
 * English is the default on purpose. We deliberately do NOT auto-detect from
 * `navigator.language`: a silent switch based on OS settings is surprising,
 * and the Settings picker is one click away. Flip this if that trade-off
 * changes.
 */
export const DEFAULT_LOCALE: Locale = 'en';

export const SUPPORTED_LOCALES: readonly LocaleDescriptor[] = Object.freeze([
  LOCALES[DEFAULT_LOCALE],
  LOCALES.zh,
]);

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, value);
}

const LOCALE_KEY = 'uiLocale';
/**
 * Phase D / D1 — the locale lives in the local business database in
 * the desktop app, and in localStorage in the browser dev server.
 */
const settings = runtimeSettingsStore();

/**
 * Read the persisted locale.
 *
 * Returns `null` when nothing is stored (first run) or when the stored value is
 * not a locale we still ship — a user who had `ja` selected and then ran a build
 * without it falls back to the default rather than seeing raw keys.
 *
 * Phase D / D1 — the legacy migration runs first, so a locale that an
 * older version kept in localStorage is found in the database and the
 * user's choice does not look like it was lost.
 */
export async function loadLocale(): Promise<Locale | null> {
  try {
    await ensureLegacyMigration();
    const stored = await settings.get<unknown>(LOCALE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    // No localStorage (some embedded runtimes), or the database could
    // not be opened. Not worth failing startup over.
    return null;
  }
}

export async function persistLocale(locale: Locale): Promise<void> {
  try {
    await settings.set(LOCALE_KEY, locale);
  } catch {
    // Persistence is best-effort: the in-memory switch still works for this
    // session, and losing the choice on restart beats crashing the picker.
  }
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Look up `key` and substitute `{placeholders}`.
 *
 * Falls back to English when a key is somehow missing from the active
 * dictionary, then to the raw key. Both should be unreachable — the
 * `Dictionary` type makes a missing key a compile error — but a blank label is
 * a much worse failure than visible English, so the chain is worth the three
 * lines.
 */
export function translate(locale: Locale, key: TranslationKey, params?: TranslationParams): string {
  const template = LOCALES[locale].dictionary[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Translator function handed to components by `useI18n()`. */
export type Translate = (key: TranslationKey, params?: TranslationParams) => string;
