/**
 * ConnectView — Phase 6 entry point for pairing.
 *
 * Transport modes:
 *   - Loopback: in-process pairing via `LoopbackHub` (browser / single-machine).
 *   - LAN: UDP discovery + TCP (Tauri runtime only).
 *   - WebRTC: DataChannel + manual SDP copy/paste (cross-network Mode B).
 *
 * Within each transport:
 *   - Host / Join flows as before; WebRTC adds blob exchange UI.
 *
 * 开发手册.md § 18, § 44, Phase 6 + Phase 13.
 */

import { useEffect, useRef, useState, type FocusEvent, type FormEvent } from 'react';
import type { MatchOrchestrator } from '@kindora/matching';
import type { ConnectionState } from '@kindora/transport';
import {
  decodeQrPayload,
  formatPairingFingerprint,
  type PairingSession,
} from '@kindora/transport';
import { PairingLink } from '../components/PairingLink';
import { startHost, startJoin, toConnectInput, type ConnectHandle } from '../lib/connect-service';
import {
  isLanAvailable,
  startLanHost,
  startLanJoin,
  toLanInput,
  type LanConnectHandle,
} from '../lib/lan-connect-service';
import {
  isWebRtcConnectAvailable,
  isWebRtcLabAvailable,
  isWebRtcServerSignallingAvailable,
  startWebRtcHost,
  startWebRtcJoin,
  type WebRtcConnectHandle,
  type WebRtcSignallingMode,
} from '../lib/webrtc-connect-service';
import { ConnectionStatus } from './ConnectionStatus';
import { useTranslate } from '../i18n';

export type ConnectMode = 'host' | 'join';
export type TransportMode = 'loopback' | 'lan' | 'webrtc';

export interface ConnectViewProps {
  /** Whether the LLM is configured. Pairing without an LLM is meaningless. */
  readonly llmReady: boolean;
  /** Heading for the "LLM not ready" banner. */
  readonly llmNotReadyTitle?: string;
  /** Body for the "LLM not ready" banner. */
  readonly llmNotReadyBody?: string;
  /** Called once pairing has produced a usable handle. */
  readonly onConnected: (handle: ConnectHandle) => void;
  /** Called when the user cancels. */
  readonly onCancel: () => void;
}

export function ConnectView({
  llmReady,
  llmNotReadyTitle,
  llmNotReadyBody,
  onConnected,
  onCancel,
}: ConnectViewProps) {
  const t = useTranslate();
  const [mode, setMode] = useState<ConnectMode>('host');
  const [transport, setTransport] = useState<TransportMode>(isLanAvailable() ? 'lan' : 'loopback');
  const lanAvailable = isLanAvailable();
  const webrtcAvailable = isWebRtcConnectAvailable();

  return (
    <main className="kindora-page">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('connect.eyebrow')}
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{t('connect.title')}</h1>
          <p className="text-kindora-600 dark:text-kindora-300 mt-2 max-w-md text-sm leading-relaxed">
            {t('connect.body')}
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </header>

      {!llmReady && (
        <section className="kindora-card flex flex-col gap-2">
          <h2 className="text-xs uppercase tracking-wide text-rose-600 dark:text-rose-400">
            {llmNotReadyTitle ?? t('connect.llmNotConfigured')}
          </h2>
          <p className="text-sm leading-relaxed">
            {llmNotReadyBody ?? t('connect.llmNotConfiguredBody')}
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
            {t('connect.host')}
          </button>
          <button
            type="button"
            className={`kindora-toggle ${mode === 'join' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setMode('join')}
          >
            {t('connect.join')}
          </button>
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={`kindora-toggle ${transport === 'lan' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setTransport('lan')}
            disabled={!lanAvailable}
            title={lanAvailable ? t('connect.lanTitle') : t('connect.lanUnavailableTitle')}
          >
            {t('connect.lan')}
          </button>
          <button
            type="button"
            className={`kindora-toggle ${transport === 'webrtc' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setTransport('webrtc')}
            disabled={!webrtcAvailable}
            title={
              webrtcAvailable ? t('connect.webrtcTitle') : t('connect.webrtcUnavailableTitle')
            }
          >
            {t('connect.webrtc')}
          </button>
          <button
            type="button"
            className={`kindora-toggle ${transport === 'loopback' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
            onClick={() => setTransport('loopback')}
            title={t('connect.loopbackTitle')}
          >
            {t('connect.loopback')}
          </button>
        </div>
      </div>

      {transport === 'webrtc' ? (
        mode === 'host' ? (
          <WebRtcHostPanel llmReady={llmReady} onConnected={onConnected} />
        ) : (
          <WebRtcJoinPanel llmReady={llmReady} onConnected={onConnected} />
        )
      ) : mode === 'host' ? (
        <HostPanel llmReady={llmReady} transport={transport} onConnected={onConnected} />
      ) : (
        <JoinPanel llmReady={llmReady} transport={transport} onConnected={onConnected} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Phase A / A3 — surface a **security** failure to the user.
 *
 * The session closes itself with a specific `closeReason` when a check
 * fails outright (a fingerprint that does not match, a peer that
 * contradicts its own capability claim, a failed key agreement). Those
 * are not "the other person cancelled" — the user needs to know that
 * the pairing was refused and why.
 *
 * Phase C / C2 — the same mechanism now carries the **transport** close
 * reasons. The Rust side reports why a link ended, the transport
 * classifies it, the session stores it in `closeReason`, and this hook
 * turns it into a message. Without this the UI could only say
 * "something went wrong", which is exactly the "异常关闭被误判" case
 * C2 § 6 rules out.
 */
function useCloseReasonError(
  session: PairingSession | null | undefined,
  onError: (message: string) => void,
): void {
  const t = useTranslate();
  useEffect(() => {
    if (!session) return undefined;
    return session.onStateChange((snap) => {
      if (snap.state !== 'closed') return;
      if (snap.closeReason === 'peer-fingerprint-mismatch') {
        onError(t('connect.fingerprintMismatch'));
        return;
      }
      if (snap.closeReason === 'limit-exceeded') {
        onError(t('connect.limitExceeded'));
        return;
      }
      if (snap.closeReason === 'invalid-frame') {
        onError(t('connect.invalidFrame'));
        return;
      }
      if (snap.closeReason === 'peer-closed') {
        onError(t('connect.peerDisconnected'));
        return;
      }
      if (snap.closeReason === 'webrtc-connect-timeout') {
        onError(t('connect.webrtcTimeout'));
      }
    });
  }, [session, onError, t]);
}

/* ------------------------------------------------------------------ */
/* Connection lifecycle (Phase C / C3 § 1 + § 8)                        */
/* ------------------------------------------------------------------ */

/**
 * Follow the LAN connection lifecycle and offer a reconnect.
 *
 * Returns:
 *   - `state` — the current connection state, or `null` when the
 *     handle does not report one (the in-process loopback path has
 *     no "the peer went away" event).
 *   - `reconnect` — a callback that asks the service to pair again,
 *     or `null` when there is nothing to reconnect.
 *   - `error` — why the last reconnect attempt failed, if it did.
 *
 * The reconnect itself lives in `lan-connect-service`: it rebuilds
 * the transport and the session from scratch, so the identity check
 * and the secure handshake are redone (C3 § 5).
 */
function useLanConnectionState(handle: LanConnectHandle | null): {
  state: ConnectionState | null;
  reconnect: (() => void) | null;
  error: string | null;
} {
  const [state, setState] = useState<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle) {
      setState(null);
      return undefined;
    }
    setState(handle.connectionState());
    return handle.onConnectionStateChange((next) => {
      setState(next);
    });
  }, [handle]);

  const reconnect = handle
    ? () => {
        setError(null);
        // The two roles have different return types; the caller does
        // not care, so widen it once here.
        const attempt: Promise<unknown> =
          handle.role === 'host' ? handle.reconnect() : handle.reconnect();
        void attempt.catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      }
    : null;

  return { state, reconnect, error };
}

/** Phase C / C3 — WebRTC Mode B has no auto-reconnect (needs a fresh SDP). */
function useWebRtcConnectionState(handle: WebRtcConnectHandle | null): {
  state: ConnectionState | null;
} {
  const [state, setState] = useState<ConnectionState | null>(null);
  useEffect(() => {
    if (!handle) {
      setState(null);
      return undefined;
    }
    setState(handle.connectionState());
    return handle.onConnectionStateChange((next) => {
      setState(next);
    });
  }, [handle]);
  return { state };
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
  transport: Exclude<TransportMode, 'webrtc'>;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const t = useTranslate();
  const [handle, setHandle] = useState<ConnectHandle | null>(null);
  const [lanHandle, setLanHandle] = useState<LanConnectHandle | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Phase C / C3 § 8 — follow the connection lifecycle so the user
  // sees 连接中 / 已连接 / 断开 / 重连中 / 失败 while the pairing runs.
  const lan = useLanConnectionState(lanHandle);

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

  // Phase A / A3 — a failed identity check closes the session with a
  // specific reason. Show it instead of a silent hang.
  useCloseReasonError(handle?.session ?? lanHandle?.session, setError);

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

    const start = async (): Promise<void> => {
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
    };

    void start();

    return () => {
      // The host this effect started has to go away when the effect is
      // torn down — which happens when the transport changes AND when
      // React StrictMode runs the effect twice in development.
      //
      // The cleanup used to only flip `cancelled`, leaving the host
      // alive on the Rust side. The Rust side owns a single host slot
      // and a fixed UDP discovery port, so the next start either hit
      // "already running in mode host" or raced the old responder's
      // teardown and lost the bind with EADDRINUSE.
      //
      // The handle may not exist yet — `start` is still awaiting the
      // IPC. `start` handles that case itself: it sees `cancelled` and
      // disconnects the handle it just created. So this cleanup only
      // has to deal with handles that already exist.
      cancelled = true;
      const lh = lanHandleRef.current;
      lanHandleRef.current = null;
      if (lh) {
        void lh.disconnect('cancelled');
      }
      const h = handleRef.current;
      handleRef.current = null;
      if (h) {
        void h.disconnect('cancelled');
      }
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
        let cachedSession: PairingSession | null = null;
        const bridged: ConnectHandle = {
          pairingCode: lanHandle.pairingCode,
          // Phase C / C3: a getter, not a captured reference. A
          // reconnect builds a NEW session on the LAN handle, and a
          // value captured here would keep pointing at the dead one.
          get session(): PairingSession {
            return lanHandle.session;
          },
          selfAgentId: lanHandle.selfAgentId,
          envelopeAuth: lanHandle.envelopeAuth,
          pairingRole: 'host',
          get orchestrator() {
            // The orchestrator is cached so repeated reads return the
            // SAME instance — calling `lanHandle.getOrchestrator()`
            // twice would create two MatchOrchestrators on the same
            // session (double LLM call, duplicate match_request
            // envelopes).
            //
            // Phase C / C3: the cache is keyed on the session. After a
            // reconnect the LAN handle has a new session, and the
            // orchestrator latches the peer's identity from the first
            // message it sees — a cached one would carry the dead
            // peer's state.
            if (!cachedOrchestrator || cachedSession !== lanHandle.session) {
              cachedOrchestrator = lanHandle.getOrchestrator();
              cachedSession = lanHandle.session;
            }
            return cachedOrchestrator;
          },
          state: snap.state,
          // Phase C / C3 § 1 + § 8 — the connection lifecycle, so the
          // next screen can show 连接中 / 已连接 / 断开 / 重连中 / 失败
          // and offer a reconnect.
          connectionState: () => lanHandle.connectionState(),
          onConnectionStateChange: (handler) => lanHandle.onConnectionStateChange(handler),
          reconnect: async () => {
            await lanHandle.reconnect();
          },
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
        <h2 className="text-xs uppercase tracking-wide text-rose-600 dark:text-rose-400">
          {t('common.error')}
        </h2>
        <p className="text-sm leading-relaxed">{error}</p>
      </section>
    );
  }
  const code = handle?.pairingCode ?? lanHandle?.pairingCode;
  if (!code) {
    return (
      <p className="text-kindora-500 dark:text-kindora-400 text-sm">{t('connect.preparingRoom')}</p>
    );
  }
  return (
    <section className="kindora-card flex flex-col items-center gap-4">
      <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t(transport === 'lan' ? 'connect.shareCodeLan' : 'connect.shareCodeLoopback')}
      </h2>
      {/* Phase A / A3 — host identity fingerprint (not a password). */}
      <HostFingerprint code={code} />
      <p className="text-kindora-500 dark:text-kindora-400 text-center text-sm">
        {t('connect.waitingForPeer')}
      </p>
      {lan.state && (
        <ConnectionStatus
          state={lan.state}
          onReconnect={lan.reconnect ?? undefined}
          error={lan.error}
        />
      )}
      <p
        className="text-kindora-600 dark:text-kindora-300 max-w-md text-center text-xs leading-relaxed"
        data-testid="host-fingerprint-hint"
      >
        {t('connect.fingerprintHint')}
      </p>
      {(handle || lanHandle) && (
        <PairingLink
          code={code}
          agentId={(handle ?? lanHandle)!.selfAgentId}
        />
      )}
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
  transport: Exclude<TransportMode, 'webrtc'>;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const t = useTranslate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localFingerprint, setLocalFingerprint] = useState<string | null>(null);
  /**
   * Phase A / A3 — the session of the in-flight join, kept in state so
   * a security failure (e.g. a fingerprint that does not match) can be
   * surfaced instead of the panel looking stuck.
   */
  const [session, setSession] = useState<PairingSession | null>(null);
  /**
   * Phase C / C3 § 8 — the LAN handle, kept in state so the panel can
   * show the connection lifecycle and offer a reconnect while the
   * pairing is running.
   */
  const [lanHandle, setLanHandle] = useState<LanConnectHandle | null>(null);

  useCloseReasonError(session, setError);

  // Phase C / C3 § 8 — follow the connection lifecycle.
  const lan = useLanConnectionState(lanHandle);

  // IBR-5 — joiner shows local fingerprint so the host can confirm.
  useEffect(() => {
    if (!llmReady) return;
    let cancelled = false;
    void (async () => {
      try {
        const input =
          transport === 'lan' ? await toLanInput() : await toConnectInput();
        if (!cancelled) setLocalFingerprint(input.fingerprint);
      } catch {
        /* agent / LLM not ready — form already gated */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [llmReady, transport]);

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
        setSession(h.session);
        // Phase C / C3 § 8: keep the handle so the panel can show the
        // connection lifecycle and offer a reconnect.
        setLanHandle(h);
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
        let cachedSession: PairingSession | null = null;
        const bridged: ConnectHandle = {
          pairingCode: h.pairingCode,
          // Phase C / C3: a getter — a reconnect builds a NEW session
          // on the LAN handle.
          get session(): PairingSession {
            return h.session;
          },
          selfAgentId: h.selfAgentId,
          envelopeAuth: h.envelopeAuth,
          pairingRole: 'join',
          get orchestrator() {
            // Cache the orchestrator so repeated reads of
            // `bridged.orchestrator` return the SAME instance — calling
            // `h.getOrchestrator()` twice would create two
            // MatchOrchestrators on the same session.
            //
            // Phase C / C3: the cache is keyed on the session, so a
            // reconnect does not reuse the orchestrator that latched
            // the previous peer's identity.
            if (!cachedOrchestrator || cachedSession !== h.session) {
              cachedOrchestrator = h.getOrchestrator();
              cachedSession = h.session;
            }
            return cachedOrchestrator;
          },
          state: 'tcp-connected',
          // Phase C / C3 § 1 + § 8 — the connection lifecycle.
          connectionState: () => h.connectionState(),
          onConnectionStateChange: (handler) => h.onConnectionStateChange(handler),
          reconnect: async () => {
            await h.reconnect();
          },
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
        setSession(handle.session);
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
        {t(transport === 'lan' ? 'connect.pairingCodeLan' : 'connect.pairingCodeLoopback')}
      </label>
      <input
        type="text"
        inputMode="text"
        autoComplete="off"
        autoFocus
        placeholder={t('connect.codePlaceholder')}
        value={code}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const fromUrl = decodeQrPayload(raw);
          if (fromUrl) {
            setCode(fromUrl.code);
            return;
          }
          setCode(e.target.value.toUpperCase());
        }}
        className="kindora-input font-mono tracking-[0.3em]"
        maxLength={120}
        data-testid="join-code-input"
      />
      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      {lan.state && (
        <ConnectionStatus
          state={lan.state}
          onReconnect={lan.reconnect ?? undefined}
          error={lan.error}
        />
      )}
      <button
        type="submit"
        className="kindora-button self-start"
        disabled={!llmReady || busy || code.length < 4}
      >
        {busy
          ? t(transport === 'lan' ? 'connect.searchingLan' : 'connect.joining')
          : t('connect.join')}
      </button>
      <p className="text-kindora-600 dark:text-kindora-300 text-xs leading-relaxed">
        {t('connect.fingerprintHint')}
      </p>
      {localFingerprint && (
        <div
          className="border-kindora-200 dark:border-kindora-700 mt-2 flex w-full flex-col items-center gap-1 border-t pt-3"
          data-testid="joiner-local-fingerprint"
        >
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            {t('connect.localFingerprintLabel')}
          </p>
          <p className="font-mono text-2xl font-semibold tracking-[0.3em]">
            {formatPairingFingerprint(localFingerprint)}
          </p>
          <p className="text-kindora-600 dark:text-kindora-300 text-center text-xs leading-relaxed">
            {t('connect.localFingerprintHint')}
          </p>
        </div>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* WebRTC host panel                                                    */
/* ------------------------------------------------------------------ */

function selectAllOnFocus(e: FocusEvent<HTMLTextAreaElement>): void {
  e.currentTarget.select();
}

function WebRtcHostPanel({
  llmReady,
  onConnected,
}: {
  llmReady: boolean;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const t = useTranslate();
  const labAvailable = isWebRtcLabAvailable();
  const serverAvailable = isWebRtcServerSignallingAvailable();
  const [signallingMode, setSignallingMode] = useState<WebRtcSignallingMode>(
    labAvailable ? 'lab' : serverAvailable ? 'server' : 'manual',
  );
  const [handle, setHandle] = useState<WebRtcConnectHandle | null>(null);
  const [offerBlob, setOfferBlob] = useState<string | null>(null);
  const [answerPaste, setAnswerPaste] = useState('');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [answerApplied, setAnswerApplied] = useState(false);
  /** Bump to tear down and mint a fresh offer (Mode B has no silent ICE restart). */
  const [restartToken, setRestartToken] = useState(0);
  const handleRef = useRef<WebRtcConnectHandle | null>(null);
  const conn = useWebRtcConnectionState(handle);

  useCloseReasonError(handle?.session, setFatalError);

  useEffect(() => {
    return () => {
      const h = handleRef.current;
      handleRef.current = null;
      if (h) void h.disconnect('cancelled');
    };
  }, []);

  useEffect(() => {
    if (!llmReady) return;
    let cancelled = false;
    setHandle(null);
    setOfferBlob(null);
    setAnswerApplied(false);
    setAnswerPaste('');
    setFatalError(null);
    setPasteError(null);

    const start = async (): Promise<void> => {
      try {
        const input = await toConnectInput();
        if (cancelled) return;
        const h = startWebRtcHost(input, { signallingMode });
        if (cancelled) {
          await h.disconnect('cancelled');
          return;
        }
        handleRef.current = h;
        setHandle(h);
        if (signallingMode === 'manual') {
          const blob = await h.takeOutboundBlob();
          if (cancelled) {
            await h.disconnect('cancelled');
            return;
          }
          setOfferBlob(blob);
        }
      } catch (e: unknown) {
        if (!cancelled) setFatalError(e instanceof Error ? e.message : String(e));
      }
    };

    void start();
    return () => {
      cancelled = true;
      const h = handleRef.current;
      handleRef.current = null;
      if (h) void h.disconnect('cancelled');
    };
  }, [llmReady, signallingMode, restartToken]);

  useEffect(() => {
    if (!handle) return undefined;
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
  }, [handle, onConnected]);

  async function copyOffer(): Promise<void> {
    if (!offerBlob) return;
    try {
      await navigator.clipboard.writeText(offerBlob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e: unknown) {
      setPasteError(e instanceof Error ? e.message : String(e));
    }
  }

  function applyAnswer(): void {
    if (!handle || !answerPaste.trim()) return;
    try {
      handle.applyInboundBlob(answerPaste.trim());
      setAnswerApplied(true);
      setPasteError(null);
    } catch {
      setPasteError(t('connect.badSignalBlob'));
      setAnswerApplied(false);
    }
  }

  if (!llmReady) return null;
  if (fatalError && !handle) {
    return (
      <section className="kindora-card flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wide text-rose-600 dark:text-rose-400">
          {t('common.error')}
        </h2>
        <p className="text-sm leading-relaxed">{fatalError}</p>
      </section>
    );
  }
  const preparing =
    !handle || (signallingMode === 'manual' && !offerBlob);
  if (preparing) {
    return (
      <div className="flex flex-col gap-3">
        <WebRtcModeToggle
          mode={signallingMode}
          labAvailable={labAvailable}
          serverAvailable={serverAvailable}
          onChange={setSignallingMode}
        />
        <p className="text-kindora-500 dark:text-kindora-400 text-sm">
          {t('connect.webrtcPreparing')}
        </p>
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <WebRtcModeToggle
        mode={signallingMode}
        labAvailable={labAvailable}
        serverAvailable={serverAvailable}
        onChange={setSignallingMode}
      />
      {fatalError && (
        <p className="text-sm text-rose-600 dark:text-rose-400" data-testid="webrtc-host-fatal">
          {fatalError}
        </p>
      )}
      <div className="kindora-card flex flex-col items-center gap-3">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('connect.shareCodeWebRtc')}
        </h2>
        <HostFingerprint code={handle!.pairingCode} />
        <p className="text-kindora-600 dark:text-kindora-300 max-w-md text-center text-xs leading-relaxed">
          {t('connect.fingerprintHint')}
        </p>
        {signallingMode === 'lab' ? (
          <p className="text-kindora-500 dark:text-kindora-400 text-center text-sm">
            {t('connect.labWaiting')}
          </p>
        ) : signallingMode === 'server' ? (
          <p className="text-kindora-500 dark:text-kindora-400 text-center text-sm">
            {t('connect.serverWaiting')}
          </p>
        ) : (
          <PairingLink code={handle!.pairingCode} agentId={handle!.selfAgentId} />
        )}
      </div>

      {signallingMode === 'manual' && offerBlob && (
        <>
          <div className="kindora-card flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
                {t('connect.offerBlob')}
              </label>
              <button
                type="button"
                className="kindora-button-ghost text-xs"
                onClick={() => void copyOffer()}
              >
                {copied ? t('connect.copied') : t('connect.copyBlob')}
              </button>
            </div>
            <textarea
              readOnly
              value={offerBlob}
              rows={4}
              onFocus={selectAllOnFocus}
              className="kindora-input font-mono text-xs leading-relaxed"
              data-testid="webrtc-offer-blob"
            />
          </div>

          <div className="kindora-card flex flex-col gap-2">
            <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
              {t('connect.pasteAnswer')}
            </label>
            <textarea
              value={answerPaste}
              onChange={(e) => {
                setAnswerPaste(e.target.value);
                if (pasteError) setPasteError(null);
              }}
              onFocus={selectAllOnFocus}
              rows={4}
              className="kindora-input font-mono text-xs leading-relaxed"
              data-testid="webrtc-answer-paste"
              disabled={answerApplied}
            />
            {pasteError && (
              <p
                className="text-sm text-rose-600 dark:text-rose-400"
                data-testid="webrtc-paste-error"
              >
                {pasteError}
              </p>
            )}
            <button
              type="button"
              className="kindora-button self-start"
              onClick={applyAnswer}
              disabled={answerApplied || answerPaste.trim().length < 8}
            >
              {t('connect.applyAnswer')}
            </button>
            {answerApplied && (
              <p className="text-kindora-500 dark:text-kindora-400 text-sm">
                {t('connect.webrtcConnecting')}
              </p>
            )}
          </div>
        </>
      )}
      {conn.state && (
        <ConnectionStatus
          state={conn.state}
          onReconnect={
            conn.state === 'failed' || conn.state === 'disconnected'
              ? () => setRestartToken((n) => n + 1)
              : undefined
          }
        />
      )}
    </section>
  );
}

function HostFingerprint({ code }: { readonly code: string }) {
  const t = useTranslate();
  const [copied, setCopied] = useState(false);
  const [nativeOk, setNativeOk] = useState<boolean | null>(null);
  const display = formatPairingFingerprint(code);
  const pasteable = code.replace(/[\s-]/g, '').toUpperCase();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { isNativeFingerprintAvailable, verifyPeerFingerprint } =
        await import('../lib/native-fingerprint');
      if (!isNativeFingerprintAvailable()) {
        if (!cancelled) setNativeOk(null);
        return;
      }
      // Self-check: Rust normalises dash/case the same way the UI does.
      const ok = await verifyPeerFingerprint(pasteable, code);
      if (!cancelled) setNativeOk(ok);
    })();
    return () => {
      cancelled = true;
    };
  }, [code, pasteable]);

  async function copyFingerprint(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pasteable);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be denied in tests / locked-down hosts */
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <p
        className="font-mono text-5xl font-semibold tracking-[0.4em]"
        data-testid="host-pairing-code"
        data-native-fingerprint={
          nativeOk === null ? 'fallback' : nativeOk ? 'verified' : 'mismatch'
        }
      >
        {display}
      </p>
      <button
        type="button"
        className="kindora-button-ghost text-xs"
        onClick={() => void copyFingerprint()}
        data-testid="host-copy-fingerprint"
      >
        {copied ? t('connect.copied') : t('connect.copyFingerprint')}
      </button>
    </div>
  );
}

function WebRtcModeToggle({
  mode,
  labAvailable,
  serverAvailable,
  onChange,
}: {
  mode: WebRtcSignallingMode;
  labAvailable: boolean;
  serverAvailable: boolean;
  onChange: (mode: WebRtcSignallingMode) => void;
}) {
  const t = useTranslate();
  return (
    <div className="flex flex-wrap gap-2" data-testid="webrtc-mode-toggle">
      <button
        type="button"
        className={`kindora-toggle ${mode === 'lab' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
        disabled={!labAvailable}
        title={labAvailable ? t('connect.labTitle') : t('connect.labUnavailable')}
        onClick={() => onChange('lab')}
      >
        {t('connect.lab')}
      </button>
      <button
        type="button"
        className={`kindora-toggle ${mode === 'server' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
        disabled={!serverAvailable}
        title={serverAvailable ? t('connect.serverTitle') : t('connect.serverUnavailable')}
        onClick={() => onChange('server')}
        data-testid="webrtc-mode-server"
      >
        {t('connect.server')}
      </button>
      <button
        type="button"
        className={`kindora-toggle ${mode === 'manual' ? 'kindora-toggle-active' : 'kindora-toggle-idle'}`}
        title={t('connect.manualTitle')}
        onClick={() => onChange('manual')}
      >
        {t('connect.manual')}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* WebRTC join panel                                                    */
/* ------------------------------------------------------------------ */

function WebRtcJoinPanel({
  llmReady,
  onConnected,
}: {
  llmReady: boolean;
  onConnected: ConnectViewProps['onConnected'];
}) {
  const t = useTranslate();
  const labAvailable = isWebRtcLabAvailable();
  const serverAvailable = isWebRtcServerSignallingAvailable();
  const [signallingMode, setSignallingMode] = useState<WebRtcSignallingMode>(
    labAvailable ? 'lab' : serverAvailable ? 'server' : 'manual',
  );
  const [code, setCode] = useState('');
  const [offerPaste, setOfferPaste] = useState('');
  const [answerBlob, setAnswerBlob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [joined, setJoined] = useState(false);
  const [session, setSession] = useState<PairingSession | null>(null);
  const [rtcHandle, setRtcHandle] = useState<WebRtcConnectHandle | null>(null);
  const handleRef = useRef<WebRtcConnectHandle | null>(null);
  const mountedRef = useRef(true);
  const conn = useWebRtcConnectionState(rtcHandle);

  function restartWebRtcJoin(): void {
    const h = handleRef.current;
    handleRef.current = null;
    if (h) void h.disconnect('cancelled');
    setRtcHandle(null);
    setSession(null);
    setJoined(false);
    setAnswerBlob(null);
    setOfferPaste('');
    setError(null);
    setBusy(false);
  }

  useCloseReasonError(session, setError);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const h = handleRef.current;
      handleRef.current = null;
      if (h) void h.disconnect('cancelled');
    };
  }, []);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!llmReady) return;
    setBusy(true);
    setError(null);
    try {
      const input = await toConnectInput();
      if (!mountedRef.current) return;
      const h = await startWebRtcJoin({
        ...input,
        code: code.trim(),
        offerBlob: signallingMode === 'manual' ? offerPaste.trim() : undefined,
        signallingMode,
      });
      if (!mountedRef.current) {
        await h.disconnect('cancelled');
        return;
      }
      handleRef.current = h;
      setSession(h.session);
      setRtcHandle(h);
      setJoined(true);

      if (signallingMode === 'manual') {
        const blob = await h.takeOutboundBlob();
        if (!mountedRef.current) {
          await h.disconnect('cancelled');
          return;
        }
        setAnswerBlob(blob);
      }

      let fired = false;
      h.session.onStateChange((snap) => {
        if (fired) return;
        if (snap.state !== 'tcp-connected' && snap.state !== 'connected') return;
        fired = true;
        if (mountedRef.current) onConnected(h);
      });
    } catch (err: unknown) {
      if (mountedRef.current) {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          /signalling blob|base64|JSON|role must|version/i.test(message)
            ? t('connect.badSignalBlob')
            : message,
        );
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function copyAnswer(): Promise<void> {
    if (!answerBlob) return;
    try {
      await navigator.clipboard.writeText(answerBlob);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const canSubmit =
    llmReady &&
    !busy &&
    !joined &&
    code.length >= 4 &&
    (signallingMode === 'lab' ||
      signallingMode === 'server' ||
      offerPaste.trim().length >= 8);

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
      <WebRtcModeToggle
        mode={signallingMode}
        labAvailable={labAvailable}
        serverAvailable={serverAvailable}
        onChange={(mode) => {
          if (joined) return;
          setSignallingMode(mode);
        }}
      />
      <div className="kindora-card flex flex-col gap-3">
        <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('connect.pairingCodeWebRtc')}
        </label>
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoFocus
          placeholder={t('connect.codePlaceholder')}
          value={code}
          onChange={(e) => {
            const raw = e.target.value.trim();
            const fromUrl = decodeQrPayload(raw);
            if (fromUrl) {
              setCode(fromUrl.code);
              return;
            }
            setCode(e.target.value.toUpperCase());
          }}
          className="kindora-input font-mono tracking-[0.3em]"
          maxLength={120}
          data-testid="join-code-input"
          disabled={joined}
        />

        {signallingMode === 'manual' && (
          <>
            <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
              {t('connect.pasteOffer')}
            </label>
            <textarea
              value={offerPaste}
              onChange={(e) => setOfferPaste(e.target.value)}
              onFocus={selectAllOnFocus}
              rows={4}
              className="kindora-input font-mono text-xs leading-relaxed"
              data-testid="webrtc-offer-paste"
              disabled={joined}
            />
          </>
        )}

        {signallingMode === 'lab' && (
          <p className="text-kindora-500 dark:text-kindora-400 text-xs leading-relaxed">
            {t('connect.labJoinHint')}
          </p>
        )}

        {error && (
          <p className="text-sm text-rose-600 dark:text-rose-400" data-testid="webrtc-join-error">
            {error}
          </p>
        )}

        {!joined ? (
          <button type="submit" className="kindora-button self-start" disabled={!canSubmit}>
            {busy
              ? t('connect.joining')
              : signallingMode === 'lab'
                ? t('connect.join')
                : t('connect.createAnswer')}
          </button>
        ) : signallingMode === 'manual' && answerBlob ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
                {t('connect.answerBlob')}
              </label>
              <button
                type="button"
                className="kindora-button-ghost text-xs"
                onClick={() => void copyAnswer()}
              >
                {copied ? t('connect.copied') : t('connect.copyBlob')}
              </button>
            </div>
            <textarea
              readOnly
              value={answerBlob}
              rows={4}
              onFocus={selectAllOnFocus}
              className="kindora-input font-mono text-xs leading-relaxed"
              data-testid="webrtc-answer-blob"
            />
            <p className="text-kindora-500 dark:text-kindora-400 text-sm">
              {t('connect.webrtcConnecting')}
            </p>
          </div>
        ) : (
          <p className="text-kindora-500 dark:text-kindora-400 text-sm">
            {t('connect.webrtcConnecting')}
          </p>
        )}

        {conn.state && (
          <ConnectionStatus
            state={conn.state}
            onReconnect={
              conn.state === 'failed' || conn.state === 'disconnected'
                ? restartWebRtcJoin
                : undefined
            }
          />
        )}

        <p className="text-kindora-600 dark:text-kindora-300 text-xs leading-relaxed">
          {t('connect.fingerprintHint')}
        </p>
      </div>
    </form>
  );
}
