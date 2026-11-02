/**
 * React binding for the i18n layer.
 *
 * `<I18nProvider>` must wrap the app (see `main.tsx`). Views call
 * `useI18n()` to get `{ locale, setLocale, t }`.
 *
 * `t` is rebuilt only when the locale changes, so passing it into memoised
 * children does not defeat the memo.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALES,
  loadLocale,
  persistLocale,
  translate,
  type Locale,
  type Translate,
  type TranslationParams,
} from './locale';

export interface I18nContextValue {
  readonly locale: Locale;
  readonly setLocale: (next: Locale) => void;
  readonly t: Translate;
  /** True until the persisted locale has been read back from disk. */
  readonly hydrated: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/** One-shot flag so the "no provider" warning fires once per process. */
let warnedAboutMissingProvider = false;

/**
 * Value used when a component renders outside a provider.
 *
 * We deliberately do NOT throw here. `App` wraps the tree in a provider, but
 * individual tests render a single view in isolation, and a throw would force
 * every one of them to re-wrap just to get English text. An untranslated
 * screen is a worse failure than a loud test, though, so `useI18n` warns once
 * when — and only when — there really is no provider above.
 */
function useFallbackI18n(): I18nContextValue {
  const t = useCallback<Translate>(
    (key, params?: TranslationParams) => translate(DEFAULT_LOCALE, key, params),
    [],
  );
  return useMemo<I18nContextValue>(
    () => ({ locale: DEFAULT_LOCALE, setLocale: () => {}, t, hydrated: true }),
    [t],
  );
}

export interface I18nProviderProps {
  readonly children: ReactNode;
  /** Test seam — skips the disk read and starts in this locale. */
  readonly initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE);
  const [hydrated, setHydrated] = useState(initialLocale !== undefined);

  // Read the saved choice once, on mount. This runs AFTER first paint, so the
  // initial render must already be complete in the default locale — otherwise
  // the UI would flash English before switching to Chinese.
  useEffect(() => {
    if (initialLocale !== undefined) return;
    let cancelled = false;
    void loadLocale().then((saved) => {
      if (cancelled) return;
      if (saved) setLocaleState(saved);
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [initialLocale]);

  // Keep <html lang> in sync — screen readers use it to pick a voice.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = LOCALES[locale].htmlLang;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    void persistLocale(next);
  }, []);

  const t = useCallback<Translate>(
    (key, params?: TranslationParams) => translate(locale, key, params),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t, hydrated }),
    [locale, setLocale, t, hydrated],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Read the active locale + translator.
 *
 * Falls back to the default locale (with a one-time warning) when no provider
 * is mounted — see `useFallbackI18n`.
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  const fallback = useFallbackI18n();
  // Hook order is stable: `useFallbackI18n` runs unconditionally, we just pick
  // which result to hand back. The warning therefore has to live *here* too —
  // putting it inside the fallback hook would fire it even when a provider is
  // present, because the fallback is built either way.
  if (ctx === null && !warnedAboutMissingProvider && typeof console !== 'undefined') {
    warnedAboutMissingProvider = true;
    console.warn(
      'Kindora i18n: a component called useI18n() outside <I18nProvider>. ' +
        'Falling back to the default locale — the screen will be untranslated.',
    );
  }
  return ctx ?? fallback;
}

/** Convenience hook for screens that only need the translator. */
export function useTranslate(): Translate {
  return useI18n().t;
}

export * from './locale';