/**
 * BlockedAgentsView — Phase B / B3.
 *
 * The block list is a **local, persisted** decision: the ids the user
 * blocked, with the time and (optionally) the reason. This screen is
 * where that list is visible and where it can be undone.
 *
 * Before Phase B the list was write-only — a user could block a peer
 * from the chat screen and had no way to see or undo it. Task book
 * § 五 B3 requires the list to be manageable, and to say clearly that a
 * blocked agent is refused *before* it learns anything.
 *
 * The view is presentational: the parent owns the store and reloads
 * the list after an unblock.
 */

import type { BlockedAgent } from '@kindora/storage';
import { useI18n, useTranslate } from '../i18n';

export interface BlockedAgentsViewProps {
  /** The current block list, newest first. */
  readonly entries: readonly BlockedAgent[];
  /** Called when the user unblocks an agent. */
  readonly onUnblock: (agentId: string) => void | Promise<void>;
  /** Called when the user closes the screen. */
  readonly onClose: () => void;
}

export function BlockedAgentsView({ entries, onUnblock, onClose }: BlockedAgentsViewProps) {
  const t = useTranslate();
  const { locale } = useI18n();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('home.blockedAgents')}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('blocked.title')}</h1>
          <p className="text-kindora-600 dark:text-kindora-300 mt-2 max-w-md text-sm leading-relaxed">
            {t('blocked.intro')}
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      </header>

      {entries.length === 0 ? (
        <section className="kindora-card">
          <p className="text-sm leading-relaxed">{t('blocked.empty')}</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="blocked-list">
          {entries.map((entry) => (
            <li key={entry.agentId} className="kindora-card flex flex-col gap-2">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
                    {t('blocked.agentId')}
                  </span>
                  <span className="font-mono text-sm">{entry.agentId}</span>
                </div>
                <button
                  type="button"
                  className="kindora-button-ghost"
                  onClick={() => onUnblock(entry.agentId)}
                  data-testid={`unblock-${entry.agentId}`}
                >
                  {t('blocked.unblock')}
                </button>
              </div>
              <p className="text-kindora-500 dark:text-kindora-400 text-xs">
                {t('blocked.blockedAt', { date: formatDate(entry.blockedAt, locale) })}
              </p>
              <p className="text-kindora-500 dark:text-kindora-400 text-xs">
                {entry.reason
                  ? t('blocked.reason', { reason: entry.reason })
                  : t('blocked.noReason')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * Format the block timestamp in the UI's locale.
 *
 * An unparseable timestamp is shown verbatim rather than as "Invalid
 * Date" — the raw string is still evidence, and hiding it would make a
 * bug invisible.
 */
function formatDate(iso: string, locale: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(locale);
}
