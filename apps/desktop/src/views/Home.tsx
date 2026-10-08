/**
 * Home screen — shown once an agent exists on this device.
 *
 * 开发手册.md § 42.
 */

import type { StoredAgent } from '@kindora/storage';

export interface HomeProps {
  agent: StoredAgent;
  onEdit: () => void;
  onConnect: () => void;
}

export function Home({ agent, onEdit, onConnect }: HomeProps) {
  const { profile } = agent;
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            My Agent
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-3xl font-semibold tracking-tight">
            <span className="h-3 w-3 rounded-full bg-emerald-500" aria-hidden />
            {profile.nickname || 'Unnamed'}
          </h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 font-mono text-xs">
            {agent.agentId.slice(0, 8)}…
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onEdit}>
          Edit Profile
        </button>
      </header>

      <section className="kindora-card">
        <p className="text-sm leading-relaxed">{profile.bio}</p>

        <div className="mt-6">
          <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Interests
          </h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {profile.interests.length === 0 ? (
              <span className="text-kindora-400 text-sm">No interests yet.</span>
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
              Currently
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
          Looking for
        </h2>
        <p className="mt-2 text-sm">{intentSummary(profile.socialIntent)}</p>

        <h2 className="text-kindora-500 dark:text-kindora-400 mt-6 text-xs uppercase tracking-wide">
          Conversation style
        </h2>
        <p className="mt-2 text-sm">{profile.conversationStyle.join(' · ')}</p>
      </section>

      <section className="flex justify-center pt-2">
        <button type="button" className="kindora-button px-10 py-3 text-base" onClick={onConnect}>
          Connect Agent
        </button>
      </section>
    </main>
  );
}

function intentSummary(intents: readonly string[]): string {
  if (intents.length === 0) return '—';
  return intents.map(humanize).join(' · ');
}

function humanize(intent: string): string {
  return intent
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
