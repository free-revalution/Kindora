import { describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ConnectionState, ConnectionStateHandler } from '@kindora/transport';
import { I18nProvider } from '../i18n';
import { ConnectionStatus } from '../views/ConnectionStatus';

function StatusBarFixture({
  initial,
  onLeave,
  disconnect,
}: {
  initial: ConnectionState;
  onLeave: () => void;
  disconnect: (reason?: string) => Promise<void>;
}) {
  const [handlers] = useState(() => new Set<ConnectionStateHandler>());
  const [stateRef] = useState(() => ({ current: initial }));

  function Bar() {
    const [s, setS] = useState<ConnectionState | null>(null);
    useEffect(() => {
      setS(stateRef.current);
      const handler: ConnectionStateHandler = (next) => setS(next);
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    }, []);
    if (!s) return null;
    const linkGone = s === 'disconnected' || s === 'failed';
    return (
      <div>
        <ConnectionStatus state={s} />
        {linkGone && (
          <button
            type="button"
            data-testid="connection-leave-home"
            onClick={() => {
              void disconnect('peer-link-gone');
              onLeave();
            }}
          >
            leave
          </button>
        )}
        <button
          type="button"
          data-testid="simulate-drop"
          onClick={() => {
            stateRef.current = 'disconnected';
            for (const h of handlers) h('disconnected');
          }}
        >
          drop
        </button>
      </div>
    );
  }

  return (
    <I18nProvider>
      <Bar />
    </I18nProvider>
  );
}

describe('dead-peer leave-home affordance', () => {
  it('shows leave after the link drops and calls disconnect + onLeave', async () => {
    const onLeave = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    render(
      <StatusBarFixture initial="connected" onLeave={onLeave} disconnect={disconnect} />,
    );
    expect(screen.queryByTestId('connection-leave-home')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('simulate-drop'));
    });
    fireEvent.click(screen.getByTestId('connection-leave-home'));
    expect(disconnect).toHaveBeenCalledWith('peer-link-gone');
    expect(onLeave).toHaveBeenCalled();
  });
});
