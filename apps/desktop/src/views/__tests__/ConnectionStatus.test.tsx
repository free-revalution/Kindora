/**
 * ConnectionStatus — Phase C / C3 § 8.
 *
 * The task book asks the UI to show five things about the connection:
 * 连接中 / 已连接 / 断开 / 重连中 / 失败.
 *
 * These tests pin the two halves of that contract:
 *
 *   1. every state renders its own label (so the user is never left
 *     guessing what the coloured pill means);
 *   2. the states a user can act on — `disconnected` and `failed` —
 *     offer a reconnect, and the ones that cannot be acted on do not.
 *
 * A reconnect button that shows up while the connection is still being
 * established would be a lie: there is nothing to reconnect yet.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConnectionStatus, type ConnectionStatusProps } from '../ConnectionStatus';
import { I18nProvider } from '../../i18n';

function renderStatus(props: ConnectionStatusProps) {
  return render(
    <I18nProvider initialLocale="en">
      <ConnectionStatus {...props} />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ConnectionStatus (Phase C / C3 § 8)', () => {
  it('renders a label for every connection state', () => {
    const cases: Array<[ConnectionStatusProps['state'], string]> = [
      ['idle', 'Not connected'],
      ['connecting', 'Connecting…'],
      ['connected', 'Connected'],
      ['disconnected', 'Disconnected'],
      ['reconnecting', 'Reconnecting…'],
      ['failed', 'Connection failed'],
    ];
    for (const [state, label] of cases) {
      const { unmount } = renderStatus({ state });
      const el = screen.getByTestId('connection-status');
      expect(el.getAttribute('data-state')).toBe(state);
      expect(screen.getByTestId('connection-status-label').textContent).toBe(label);
      unmount();
    }
  });

  it('offers a reconnect when the connection dropped', () => {
    renderStatus({ state: 'disconnected', onReconnect: () => undefined });
    expect(screen.getByTestId('connection-reconnect')).toBeInTheDocument();
    expect(screen.getByTestId('connection-reconnect').textContent).toBe('Reconnect');
  });

  it('offers a reconnect when the connection failed', () => {
    renderStatus({ state: 'failed', onReconnect: () => undefined });
    expect(screen.getByTestId('connection-reconnect')).toBeInTheDocument();
  });

  it('does not offer a reconnect while the connection is still coming up', () => {
    for (const state of ['idle', 'connecting', 'reconnecting', 'connected'] as const) {
      const { unmount } = renderStatus({ state, onReconnect: () => undefined });
      expect(screen.queryByTestId('connection-reconnect')).toBeNull();
      unmount();
    }
  });

  it('does not offer a reconnect when there is nothing to reconnect with', () => {
    // The in-process loopback path has no "the peer went away" event,
    // so it has no reconnect to offer.
    renderStatus({ state: 'disconnected' });
    expect(screen.queryByTestId('connection-reconnect')).toBeNull();
  });

  it('calls onReconnect when the button is clicked', () => {
    const onReconnect = vi.fn();
    renderStatus({ state: 'disconnected', onReconnect });
    fireEvent.click(screen.getByTestId('connection-reconnect'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('shows the error next to the label when one is given', () => {
    renderStatus({ state: 'failed', error: 'no peer found on the LAN' });
    expect(screen.getByTestId('connection-status-error').textContent).toBe(
      'no peer found on the LAN',
    );
  });

  it('renders no error element when there is no error', () => {
    renderStatus({ state: 'connected' });
    expect(screen.queryByTestId('connection-status-error')).toBeNull();
  });
});
