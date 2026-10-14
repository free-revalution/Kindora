/**
 * ConnectView — Phase 6 entry point for pairing.
 *
 * Two top-level modes:
 *   - Loopback (browser dev / single-machine tests): in-process pairing
 *     via `LoopbackHub`. Always available.
 *   - LAN (Tauri runtime): real UDP discovery + TCP message channel.
 *     Requires the Tauri runtime (`window.__TAURI_INTERNALS__` present).
 *
 * Within each transport:
 *   - Host:  generate a 6-char code, show it prominently, wait for peer
 *   - Join:  accept a typed code, attempt to pair
 *
 * On a successful host pair (peer arrived), the view transitions
 * out via `onConnected(handle)` with a `ConnectHandle` ready to run.
 *
 * 开发手册.md § 18, § 44, Phase 6 + Phase 13.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { startHost, startJoin, toConnectInput, type ConnectHandle } from '../lib/connect-service';
import {
  isLanAvailable,
  startLanHost,
  startLanJoin,
  toLanInput,
  type LanConnectHandle,
} from '../lib/lan-connect-service';

export type ConnectMode = 'host' | 'join';
export type TransportMode = 'loopback' | 'lan';

export interface ConnectViewProps {
  /** Whether the LLM is configured. Pairing without an LLM is meaningless. */
  readonly llmReady: boolean;
  /** Reason LLM is not ready, shown as a banner. */
  readonly llmNotReadyReason?: string;
  /** Called once pairing has produced a usable handle. */
  readonly onConnected: (handle: ConnectHandle) => void;
  /** Called when the user cancels. */
  readonly onCancel: () => void;
}

export function ConnectView({
  llmReady,
  llmNotReadyReason,
  onConnected,
  onCancel,
}: ConnectViewProps) {
  const [mode, setMode] = useState<ConnectMode>('host');
  const [transport, setTransport] = useState<TransportMode>(
    isLanAvailable() ? 'lan' : 'loopback',
  );
  const lanAvailable = isLanAvailable();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Connect
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Pair with another agent</h1>
          <p className="text-kindora-600 dark:text-kindora-300 mt-2 max-w-md text-sm leading-relaxed">
            Share a 6-character code with the other person, or type theirs. Once paired, your agents
            exchange profiles and run a local compatibility analysis.
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onCancel}>
          Cancel
        </button>
      </header>

      {!llmReady && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">
            LLM not configured
          </h2>
          <p className="text-sm leading-relaxed">
            {llmNotReadyReason ??
              'Configure an LLM provider in Settings before pairing. Pairing exchanges profiles and runs a local analysis, which needs an LLM.'}
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            className={`kindora-toggle ${mode === 'host' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setMode('host')}
          >
            Host
          </button>
          <button
            type="button"
            className={`kindora-toggle ${mode === 'join' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setMode('join')}
          >
            Join
          </button>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className={`kindora-toggle ${transport === 'lan' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setTransport('lan')}
            disabled={!lanAvailable}
            title={
              lanAvailable
                ? 'LAN: real UDP discovery + TCP message channel between two Tauri clients on the same network.'
                : 'LAN mode is only available in the Tauri desktop app (not in browser dev).'
            }
          >
            LAN
          </button>
          <button
            type="button"
            className={`kindora-toggle ${transport === 'loopback' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setTransport('loopback')}
            title="Loopback: in-process pairing (browser dev / single-machine tests)."
          >
            Loopback
          </button>
        </div>
      </div>

      {mode === 'host' ? (
        <HostPanel llmReady={llmReady} transport={transport} onConnected={onConnected} />
      ) : (
        <JoinPanel llmReady={llmReady} transport={transport} onConnected={onConnected} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Host panel                                                          */
/* ------------------------------------------------------------------ */

function HostPanel({
  llmReady,
  transport,
  onConnected,
}: {
  llmReady: boolean;
  transport: TransportMode;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const [handle, setHandle] = useState<ConnectHandle | null>(null);
  const [lanHandle, setLanHandle] = useState<LanConnectHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!llmReady) return;
    let cancelled = false;
    void (async () => {
      try {
        if (transport === 'lan') {
          const input = await toLanInput();
          const h = await startLanHost(input);
          if (cancelled) {
            await h.disconnect('cancelled');
            return;
          }
          setLanHandle(h);
        } else {
          const input = await toConnectInput();
          const h = startHost(input);
          if (cancelled) {
            await h.disconnect('cancelled');
            return;
          }
          setHandle(h);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [llmReady, transport]);

  // When the handle transitions to 'connected', call onConnected.
  useEffect(() => {
    if (transport === 'lan' && lanHandle) {
      // LAN handle exposes a PairingSession; use the same listener.
      const off = lanHandle.session.onStateChange((snap) => {
        if (snap.state === 'connected') {
          // Bridge the LanConnectHandle into a ConnectHandle by reusing
          // the in-process ConnectHandle shape. The downstream views
          // only need session + selfAgentId + orchestrator + disconnect.
          // For LAN we synthesise a minimal ConnectHandle.
          const bridged: ConnectHandle = {
            pairingCode: lanHandle.pairingCode,
            session: lanHandle.session,
            selfAgentId: lanHandle.selfAgentId,
            get orchestrator() {
              return lanHandle.getOrchestrator();
            },
            state: 'connected',
            async disconnect(reason: string = 'user-requested') {
              await lanHandle.disconnect(reason);
            },
          };
          onConnected(bridged);
        }
      });
      return () => {
        off();
      };
    }
    if (transport === 'loopback' && handle) {
      const off = handle.session.onStateChange((snap) => {
        if (snap.state === 'connected') {
          onConnected(handle);
        }
      });
      return () => {
        off();
      };
    }
    return undefined;
  }, [handle, lanHandle, transport, onConnected]);

  if (!llmReady) return null;
  if (error) {
    return (
      <section className="kindora-card flex flex-col gap-2">
        <h2 className="text-rose-600 dark:text-rose-400 text-xs uppercase tracking-wide">Error</h2>
        <p className="text-sm leading-relaxed">{error}</p>
      </section>
    );
  }
  const code = handle?.pairingCode ?? lanHandle?.pairingCode;
  if (!code) {
    return <p className="text-kindora-500 dark:text-kindora-400 text-sm">Preparing room…</p>;
  }
  return (
    <section className="kindora-card flex flex-col items-center gap-4">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        Share this code {transport === 'lan' ? '(over LAN)' : '(loopback)'}
      </h2>
      <p
        className="font-mono text-5xl font-semibold tracking-[0.4em]"
        data-testid="host-pairing-code"
      >
        {code}
      </p>
      <p className="text-kindora-500 dark:text-kindora-400 text-center text-sm">
        Waiting for the other person to enter this code…
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Join panel                                                          */
/* ------------------------------------------------------------------ */

function JoinPanel({
  llmReady,
  transport,
  onConnected,
}: {
  llmReady: boolean;
  transport: TransportMode;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!llmReady) return;
    setBusy(true);
    setError(null);
    try {
      if (transport === 'lan') {
        const input = await toLanInput();
        const h = await startLanJoin(input, code.trim());
        const bridged: ConnectHandle = {
          pairingCode: h.pairingCode,
          session: h.session,
          selfAgentId: h.selfAgentId,
          get orchestrator() {
            return h.getOrchestrator();
          },
          state: 'connected',
          async disconnect(reason: string = 'user-requested') {
            await h.disconnect(reason);
          },
        };
        onConnected(bridged);
      } else {
        const input = await toConnectInput();
        const handle = startJoin({ ...input, code: code.trim() });
        // Wait for the next tick — startJoin transitions to 'connected'
        // on the next microtask.
        await new Promise((r) => setTimeout(r, 50));
        onConnected(handle);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kindora-card flex flex-col gap-3" onSubmit={handleSubmit}>
      <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        Pairing code ({transport === 'lan' ? 'over LAN' : 'loopback'})
      </label>
      <input
        type="text"
        inputMode="text"
        autoComplete="off"
        autoFocus
        placeholder="ABCDEF"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        className="kindora-input font-mono tracking-[0.3em]"
        maxLength={12}
        data-testid="join-code-input"
      />
      {error && <p className="text-rose-600 dark:text-rose-400 text-sm">{error}</p>}
      <button
        type="submit"
        className="kindora-button self-start"
        disabled={!llmReady || busy || code.length < 4}
      >
        {busy ? (transport === 'lan' ? 'Searching LAN…' : 'Joining…') : 'Join'}
      </button>
    </form>
  );
}
