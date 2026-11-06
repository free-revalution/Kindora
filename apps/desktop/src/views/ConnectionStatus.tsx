/**
 * ConnectionStatus — Phase C / C3 § 8.
 *
 * Shows the **connection** lifecycle the way the task book asks for:
 * 连接中 / 已连接 / 断开 / 重连中 / 失败.
 *
 * The component is deliberately dumb. It takes the current state and
 * an optional reconnect callback; whoever owns the handle decides what
 * "reconnect" means and how long it takes. The state itself comes
 * from the `ConnectionStateMachine` the LAN service owns (see
 * `lan-connect-service.ts`).
 *
 * Why a separate component and not a `state` field on the pairing
 * snapshot: the pairing FSM and the connection lifecycle are different
 * questions. The FSM tracks the *protocol* handshake; this tracks the
 * *connection*. A TCP link that is up but has not authenticated yet is
 * still "connecting" — showing it as "connected" would be a lie the
 * user acts on.
 */

import type { ConnectionState } from '@kindora/transport';
import { useTranslate, type TranslationKey } from '../i18n';

export interface ConnectionStatusProps {
  /** The current connection state. */
  readonly state: ConnectionState;
  /**
   * Called when the user asks to reconnect. Omit it and the button is
   * hidden — a transport that cannot reconnect (the in-process
   * loopback) simply does not offer one.
   */
  readonly onReconnect?: (() => void) | undefined;
  /** Extra detail (e.g. the reconnect error). Shown next to the label. */
  readonly error?: string | null | undefined;
}

/**
 * The i18n key for each state. Kept next to the component so the
 * mapping is one obvious place, not five `if`s spread over two views.
 */
const STATE_KEYS: Record<ConnectionState, TranslationKey> = {
  idle: 'connect.state.idle',
  connecting: 'connect.state.connecting',
  connected: 'connect.state.connected',
  disconnected: 'connect.state.disconnected',
  reconnecting: 'connect.state.reconnecting',
  failed: 'connect.state.failed',
};

/**
 * The colour of the label. Green means "the peer is there and
 * authenticated", amber means "something is in flight", red means
 * "it is over".
 */
function toneClass(state: ConnectionState): string {
  if (state === 'connected') {
    return 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-100';
  }
  if (state === 'connecting' || state === 'reconnecting') {
    return 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100';
  }
  if (state === 'disconnected' || state === 'failed') {
    return 'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-900/40 dark:text-rose-100';
  }
  return 'border-kindora-200 bg-kindora-50 text-kindora-800 dark:border-kindora-700 dark:bg-kindora-800/40 dark:text-kindora-100';
}

export function ConnectionStatus({ state, onReconnect, error }: ConnectionStatusProps) {
  const t = useTranslate();
  const key = STATE_KEYS[state];
  const canReconnect = state === 'disconnected' || state === 'failed';
  return (
    <div
      className="flex flex-wrap items-center gap-3"
      data-testid="connection-status"
      data-state={state}
    >
      <span
        className={`inline-flex w-fit items-center gap-1 rounded-full border px-3 py-1 text-sm ${toneClass(state)}`}
        data-testid="connection-status-label"
      >
        {t(key)}
      </span>
      {canReconnect && onReconnect && (
        <button
          type="button"
          className="kindora-button-ghost"
          onClick={onReconnect}
          data-testid="connection-reconnect"
        >
          {t('connect.reconnect')}
        </button>
      )}
      {error ? (
        <span
          className="text-sm text-rose-600 dark:text-rose-400"
          data-testid="connection-status-error"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
