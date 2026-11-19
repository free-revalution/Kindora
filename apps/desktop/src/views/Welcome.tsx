/**
 * Welcome — editorial first screen.
 * Kindora wordmark is the hero; one action; no dashboard clutter.
 */

import { useTranslate } from '../i18n';

interface WelcomeProps {
  onCreate: () => void;
  onTryDemo?: () => void;
}

export function Welcome({ onCreate, onTryDemo }: WelcomeProps) {
  const t = useTranslate();
  return (
    <main
      className="relative flex h-full flex-col justify-center overflow-hidden px-10"
      data-testid="welcome-screen"
    >
      {/* Quiet warm wash — not a purple mesh */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 70% 50% at 15% 20%, rgba(237,243,236,0.9), transparent 55%), radial-gradient(ellipse 50% 40% at 90% 80%, rgba(247,246,243,0.8), transparent 50%)',
        }}
        aria-hidden
      />

      <div className="relative z-10 mx-auto w-full max-w-xl">
        <p className="kindora-eyebrow">Local-first</p>
        <h1 className="mt-4 font-display text-6xl font-medium leading-[1.05] tracking-[-0.04em] text-kindora-950 md:text-7xl">
          Kindora
        </h1>
        <p className="mt-8 max-w-md font-display text-2xl leading-snug tracking-[-0.02em] text-kindora-800">
          {t('welcome.taglineFirst')}
          <br />
          {t('welcome.taglineSecond')}
        </p>
        <p className="mt-6 max-w-md text-[15px] leading-[1.65] text-kindora-500">{t('welcome.body')}</p>

        <div className="mt-12 flex flex-wrap items-center gap-3">
          <button type="button" className="kindora-button px-6 py-2.5" onClick={onCreate}>
            {t('welcome.createAgent')}
          </button>
          {onTryDemo && (
            <button
              type="button"
              className="kindora-button-ghost px-6 py-2.5"
              onClick={onTryDemo}
              data-testid="welcome-try-demo"
            >
              {t('welcome.tryDemo')}
            </button>
          )}
        </div>
        <p className="mt-10 font-mono text-[11px] tracking-[0.04em] text-kindora-400">
          {t('welcome.footer')}
        </p>
      </div>
    </main>
  );
}
