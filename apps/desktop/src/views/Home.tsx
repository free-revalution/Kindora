/**
 * Home — agent overview as an editorial document, not a dashboard.
 */

import type { SocialIntent } from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';
import {
  SOCIAL_INTENT_SHORT_KEYS,
  CONVERSATION_STYLE_KEYS,
  useTranslate,
  type Translate,
} from '../i18n';
import { StatusDot } from '../components/StatusDot';
import { Banner } from '../components/Banner';

export interface HomeProps {
  agent: StoredAgent;
  onEdit: () => void;
  onConnect: () => void;
  onSettings: () => void;
  onBlocked?: () => void;
  onHistory?: () => void;
  onTryDemo?: () => void;
}

export function Home({
  agent,
  onEdit,
  onConnect,
  onSettings,
  onBlocked,
  onHistory,
  onTryDemo,
}: HomeProps) {
  const t = useTranslate();
  const { profile } = agent;
  return (
    <main className="kindora-page" data-testid="home-screen">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-kindora-200 pb-8">
        <div>
          <p className="kindora-eyebrow">{t('home.myAgent')}</p>
          <h1 className="mt-3 flex items-center gap-3 font-display text-4xl font-medium tracking-[-0.03em] text-kindora-950">
            <StatusDot tone="live" />
            {profile.nickname || t('home.unnamed')}
          </h1>
          <p className="mt-2 font-mono text-[11px] text-kindora-400">
            {agent.agentId.slice(0, 12)}…
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onHistory && (
            <button type="button" className="kindora-button-ghost" onClick={onHistory}>
              {t('home.chatHistory')}
            </button>
          )}
          {onBlocked && (
            <button type="button" className="kindora-button-ghost" onClick={onBlocked}>
              {t('home.blockedAgents')}
            </button>
          )}
          <button type="button" className="kindora-button-ghost" onClick={onSettings}>
            {t('home.settings')}
          </button>
          <button type="button" className="kindora-button-ghost" onClick={onEdit}>
            {t('home.editProfile')}
          </button>
        </div>
      </header>

      {agent.privateKeyStorage.kind === 'dev-localstorage' && (
        <Banner tone="warn">
          <p>{t('home.keychainDevWarning')}</p>
        </Banner>
      )}

      <section className="grid gap-px overflow-hidden rounded-[8px] border border-kindora-200 bg-kindora-200 md:grid-cols-2">
        <div className="bg-white p-7 md:col-span-2">
          <p className="text-[15px] leading-[1.65] text-kindora-800">{profile.bio}</p>
          <div className="mt-6">
            <h2 className="kindora-eyebrow">{t('home.interests')}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {profile.interests.length === 0 ? (
                <span className="text-sm text-kindora-400">{t('home.noInterests')}</span>
              ) : (
                profile.interests.map((i) => (
                  <span key={i} className="kindora-chip-plain">
                    {i}
                  </span>
                ))
              )}
            </div>
          </div>
          {profile.currentActivities.length > 0 && (
            <div className="mt-6">
              <h2 className="kindora-eyebrow">{t('home.currently')}</h2>
              <ul className="mt-3 space-y-1 text-sm text-kindora-700">
                {profile.currentActivities.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="bg-white p-7">
          <h2 className="kindora-eyebrow">{t('home.lookingFor')}</h2>
          <p className="mt-3 text-sm leading-relaxed text-kindora-800">
            {intentSummary(t, profile.socialIntent)}
          </p>
        </div>
        <div className="bg-white p-7">
          <h2 className="kindora-eyebrow">{t('home.conversationStyle')}</h2>
          <p className="mt-3 text-sm leading-relaxed text-kindora-800">
            {profile.conversationStyle.map((s) => t(CONVERSATION_STYLE_KEYS[s])).join(' · ')}
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="kindora-button px-7 py-2.5" onClick={onConnect}>
            {t('home.connectAgent')}
          </button>
          {onTryDemo && (
            <button
              type="button"
              className="kindora-button-ghost"
              onClick={onTryDemo}
              data-testid="home-try-demo"
            >
              {t('home.tryDemo')}
            </button>
          )}
        </div>
        <p className="max-w-md text-xs leading-relaxed text-kindora-400">{t('home.connectHint')}</p>
      </section>
      {onTryDemo && <p className="text-xs text-kindora-400">{t('demo.banner')}</p>}
    </main>
  );
}

function intentSummary(t: Translate, intents: readonly SocialIntent[]): string {
  if (intents.length === 0) return '—';
  return intents.map((i) => t(SOCIAL_INTENT_SHORT_KEYS[i])).join(' · ');
}
