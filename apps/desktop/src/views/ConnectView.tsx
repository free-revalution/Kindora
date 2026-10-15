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

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MatchOrchestrator } from '@kindora/matching';
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

  // Refs to the in-flight handles. Used by the unmount cleanup so
  // we always release the LAN transport + session, even when the
  // user clicks Cancel (or the parent view tears down) AFTER the
  // handle has already been created and stored in state. The state
  // variables above are for rendering only; the refs are the
  // authoritative handle ownership for the cleanup path.
  //
  // This is the fix for the § 5.2 leak documented in
  // docs/phase16/manual-lan-e2e.md: without this, the host's UDP
  // responder, TCP listener, and 200ms poll loop keep running until
  // the host side of the connection times out.
  const handleRef = useRef<ConnectHandle | null>(null);
  const lanHandleRef = useRef<LanConnectHandle | null>(null);

  // Unmount cleanup: release any in-flight handle. The disconnect
  // function is idempotent (see `lan-connect-service.ts`) so a
  // duplicate call (e.g. the user already triggered disconnect via
  // a different path) is safe.
  useEffect(() => {
    return () => {
      const h = handleRef.current;
      const lh = lanHandleRef.current;
      handleRef.current = null;
      lanHandleRef.current = null;
      if (h) {
        void h.disconnect('cancelled');
      }
      if (lh) {
        void lh.disconnect('cancelled');
      }
    };
  }, []);

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
          // Stash in ref BEFORE setLanHandle so a same-tick unmount
          // can still find it. If unmount has already happened,
          // `cancelled` is true and we already returned above.
          lanHandleRef.current = h;
          setLanHandle(h);
        } else {
          const input = await toConnectInput();
          const h = startHost(input);
          if (cancelled) {
            await h.disconnect('cancelled');
            return;
          }
          handleRef.current = h;
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

  // When the handle transitions to 'tcp-connected', call onConnected
  // ONCE. The session subsequently transitions to 'connected' once
  // the orchestrator (driven from the match view) validates the
  // peer's `hello` envelope — that transition is not a fresh
  // "paired" event, it's the match view's own milestone.
  //
  // The orchestrator accepts either 'tcp-connected' or 'connected'
  // as a start state, so it's safe to hand off the handle at the
  // first transition.
  useEffect(() => {
    if (transport === 'lan' && lanHandle) {
      let fired = false;
      const off = lanHandle.session.onStateChange((snap) => {
        if (fired) return;
        if (snap.state !== 'tcp-connected' && snap.state !== 'connected') return;
        fired = true;
        // Bridge the LanConnectHandle into a ConnectHandle by reusing
        // the in-process ConnectHandle shape. The downstream views
        // only need session + selfAgentId + orchestrator + disconnect.
        // For LAN we synthesise a minimal ConnectHandle. The
        // orchestrator is cached so repeated reads of
        // `bridged.orchestrator` return the SAME instance — calling
        // `lanHandle.getOrchestrator()` twice would create two
        // MatchOrchestrators on the same session (double LLM call,
        // duplicate match_request envelopes).
        let cachedOrchestrator: MatchOrchestrator | null = null;
        const bridged: ConnectHandle = {
          pairingCode: lanHandle.pairingCode,
          session: lanHandle.session,
          selfAgentId: lanHandle.selfAgentId,
          get orchestrator() {
            if (!cachedOrchestrator) {
              cachedOrchestrator = lanHandle.getOrchestrator();
            }
            return cachedOrchestrator;
          },
          state: snap.state,
          async disconnect(reason: string = 'user-requested') {
            await lanHandle.disconnect(reason);
          },
        };
        onConnected(bridged);
      });
      return () => {
        off();
      };
    }
    if (transport === 'loopback' && handle) {
      let fired = false;
      const off = handle.session.onStateChange((snap) => {
        if (fired) return;
        if (snap.state !== 'tcp-connected' && snap.state !== 'connected') return;
        fired = true;
        onConnected(handle);
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

  // Tracks whether the panel is still mounted. The async submit
  // path (which awaits `startLanJoin` over real UDP) can race with
  // the user clicking Cancel — when that happens, the panel
  // unmounts before the awaited call resolves. We must not call
  // `onConnected(bridged)` (which would force-navigate the user to
  // the MatchView) and we must `disconnect` the in-flight LAN
  // handle so the Rust-side resources are released.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!llmReady) return;
    setBusy(true);
    setError(null);
    try {
      if (transport === 'lan') {
        const input = await toLanInput();
        // If the user already cancelled while `toLanInput()` was
        // awaiting, drop the result without trying to connect.
        if (!mountedRef.current) return;
        const h = await startLanJoin(input, code.trim());
        // If the user cancelled during `startLanJoin` (UDP discover
        // window), the joiner may have already bound a UDP socket
        // and even established a TCP dial. Tear it down before the
        // user is force-navigated to MatchView.
        if (!mountedRef.current) {
          await h.disconnect('cancelled');
          return;
        }
        // Cache the orchestrator so repeated reads of
        // `bridged.orchestrator` return the SAME instance — calling
        // `h.getOrchestrator()` twice would create two
        // MatchOrchestrators on the same session.
        let cachedOrchestrator: MatchOrchestrator | null = null;
        const bridged: ConnectHandle = {
          pairingCode: h.pairingCode,
          session: h.session,
          selfAgentId: h.selfAgentId,
          get orchestrator() {
            if (!cachedOrchestrator) {
              cachedOrchestrator = h.getOrchestrator();
            }
            return cachedOrchestrator;
          },
          state: 'tcp-connected',
          async disconnect(reason: string = 'user-requested') {
            await h.disconnect(reason);
          },
        };
        onConnected(bridged);
      } else {
        const input = await toConnectInput();
        // Loopback path doesn't touch the network but we still
        // guard the unmount race.
        if (!mountedRef.current) return;
        const handle = startJoin({ ...input, code: code.trim() });
        // Wait for the next tick — startJoin transitions the session
        // to 'tcp-connected' (Phase 15: NOT 'connected') on the next
        // microtask. The orchestrator will drive the `hello` exchange
        // and lift it to 'connected' once it runs.
        await new Promise((r) => setTimeout(r, 50));
        if (!mountedRef.current) {
          await handle.disconnect('cancelled');
          return;
        }
        onConnected(handle);
      }
    } catch (e: unknown) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
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
