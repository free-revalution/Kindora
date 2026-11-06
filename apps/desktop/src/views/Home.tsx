/**
 * Home screen — shown once an agent exists on this device.
 *
 * 开发手册.md § 42.
 */

import type { SocialIntent } from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';
import {
  SOCIAL_INTENT_SHORT_KEYS,
  CONVERSATION_STYLE_KEYS,
  useTranslate,
  type Translate,
} from '../i18n';

export interface HomeProps {
  agent: StoredAgent;
  onEdit: () => void;
  onConnect: () => void;
  onSettings: () => void;
  /** Phase B / B3 — open the blocked-agents list. */
  onBlocked?: () => void;
  /** Phase D / D2 — open the chat history of this device. */
  onHistory?: () => void;
}

export function Home({ agent, onEdit, onConnect, onSettings, onBlocked, onHistory }: HomeProps) {
  const t = useTranslate();
  const { profile } = agent;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('home.myAgent')}
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-semibold tracking-tight">
            <span className="h-3 w-3 rounded-full bg-emerald-500" aria-hidden />
            {profile.nickname || t('home.unnamed')}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 font-mono text-xs">
            {agent.agentId.slice(0, 8)}…
          </p>
        </div>
        <div className="flex gap-2">
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

      {/* Phase A / A1 — the browser-dev fallback keeps the private key in
          localStorage. Say so, loudly, rather than implying the key is in a
          secure store. */}
      {agent.privateKeyStorage.kind === 'dev-localstorage' && (
        <section className="kindora-warning">
          <p className="text-sm leading-relaxed">{t('home.keychainDevWarning')}</p>
        </section>
      )}

      <section className="kindora-card">
        <p className="text-sm leading-relaxed">{profile.bio}</p>

        <div className="mt-6">
          <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('home.interests')}
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {profile.interests.length === 0 ? (
              <span className="text-kindora-400 text-sm">{t('home.noInterests')}</span>
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
            <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
              {t('home.currently')}
            </h2>
            <ul className="mt-2 space-y-1 text-sm">
              {profile.currentActivities.map((a) => (
                <li key={a}>· {a}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="kindora-card">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('home.lookingFor')}
        </h2>
        <p className="mt-2 text-sm">{intentSummary(t, profile.socialIntent)}</p>

        <h2 className="text-kindora-500 dark:text-kindora-400 mt-6 text-xs uppercase tracking-wide">
          {t('home.conversationStyle')}
        </h2>
        <p className="mt-2 text-sm">
          {profile.conversationStyle.map((s) => t(CONVERSATION_STYLE_KEYS[s])).join(' · ')}
        </p>
      </section>

      <section className="flex justify-center pt-2">
        <button type="button" className="kindora-button px-10 py-3 text-base" onClick={onConnect}>
          {t('home.connectAgent')}
        </button>
      </section>
    </main>
  );
}

function intentSummary(t: Translate, intents: readonly SocialIntent[]): string {
  if (intents.length === 0) return '—';
  return intents.map((i) => t(SOCIAL_INTENT_SHORT_KEYS[i])).join(' · ');
}
