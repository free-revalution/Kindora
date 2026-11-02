/**
 * Welcome screen — entry point when no agent exists on this device.
 *
 * 开发手册.md § 6.1.
 */

import { useTranslate } from '../i18n';

interface WelcomeProps {
  onCreate: () => void;
}

export function Welcome({ onCreate }: WelcomeProps) {
  const t = useTranslate();
  return (
    <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-6xl font-semibold tracking-tight">Kindora</h1>
      <p className="text-kindora-700 dark:text-kindora-200 mt-8 text-xl leading-relaxed">
        {t('welcome.taglineFirst')}
        <br />
        {t('welcome.taglineSecond')}
      </p>

      <p className="text-kindora-600 dark:text-kindora-300 mt-10 max-w-md text-sm leading-relaxed">
        {t('welcome.body')}
      </p>

      <button type="button" className="kindora-button mt-12 px-8 py-3 text-base" onClick={onCreate}>
        {t('welcome.createAgent')}
      </button>

      <p className="text-kindora-500 dark:text-kindora-400 mt-8 text-xs">
        {t('welcome.footer')}
      </p>
    </main>
  );
}
