import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SocialProfile } from '@kindora/protocol';
import { DatabaseError, type StoredAgent, type StoredChatMessage } from '@kindora/storage';
import type { ConnectionState } from '@kindora/transport';
import { Welcome } from './views/Welcome';
import { CreateAgentForm } from './views/CreateAgentForm';
import { Home } from './views/Home';
import { Settings } from './views/Settings';
import { ConnectView } from './views/ConnectView';
import { ConnectionStatus } from './views/ConnectionStatus';
import { LiveMatchView } from './views/MatchView';
import { LiveIdentifyView } from './views/IdentifyView';
import { PeerFingerprintConfirmView } from './views/PeerFingerprintConfirmView';
import { LiveConsentView } from './views/ConsentView';
import {
  markChatPhase,
  markMutualConsent,
  markPeerFingerprintVerified,
} from './lib/authorized-envelope';
import {
  sessionAdvanceChat,
  sessionConfirmPeerFingerprint,
  sessionNotePeer,
  sessionSetMutualConsent,
} from './lib/outbound-session';
import { LiveIcebreakerView } from './views/IcebreakerView';
import { LiveChatView } from './views/ChatView';
import { BlockedAgentsView } from './views/BlockedAgentsView';
import { ChatHistoryView } from './views/ChatHistoryView';
import { DemoView } from './views/DemoView';
import type { ConsentOutcome, MatchOutcome, PeerIntroduction } from '@kindora/matching';
import type { ChatMessageSource } from '@kindora/matching';
import type { BlockedAgent } from '@kindora/storage';
import type { ChatAssistHandle, ChatHandle, IcebreakerHandle } from './lib/connect-service';
import type { ConnectHandle } from './lib/connect-service';
import {
  getBlockedAgentsStore,
  runChat,
  runChatAssist,
  runConsent,
  runExchangeAndMatch,
  runIcebreaker,
  runIdentify,
} from './lib/connect-service';
import {
  isChatHistoryAvailable,
  listChatHistory,
  loadChatTranscript,
  type ChatHistorySession,
} from './lib/chat-history';
import {
  classifyAgentKeyError,
  createAgent,
  loadAgent,
  updateProfile,
  type AgentKeyFailure,
} from './lib/agent-service';
import { loadLlmStatus, type LlmStatus } from './lib/llm-service';
import { useTranslate, I18nProvider, LLM_STATUS_KEYS, type TranslationKey } from './i18n';
import { AppLayout } from './shell/AppLayout';
import { navIdForViewKind, type FlowStepId, type NavId } from './shell/nav';
import { Banner } from './components/Banner';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * The screens of the app.
 *
 * Phase B order: connect → identify → consent → match → icebreaker → chat.
 */
type View =
  | { kind: 'loading' }
  | { kind: 'welcome' }
  | { kind: 'demo' }
  | { kind: 'create' }
  | { kind: 'edit'; agent: StoredAgent }
  | { kind: 'home'; agent: StoredAgent }
  | { kind: 'settings'; agent: StoredAgent }
  | { kind: 'blocked'; agent: StoredAgent }
  | { kind: 'connect'; agent: StoredAgent }
  | { kind: 'identify'; agent: StoredAgent; handle: ConnectHandle }
  | {
      kind: 'verify-peer';
      agent: StoredAgent;
      handle: ConnectHandle;
      peer: PeerIntroduction;
    }
  | {
      kind: 'consent';
      agent: StoredAgent;
      handle: ConnectHandle;
      peer: PeerIntroduction;
    }
  | {
      kind: 'match';
      agent: StoredAgent;
      handle: ConnectHandle;
      peer: PeerIntroduction;
      consent: ConsentOutcome;
    }
  | { kind: 'keychain-error'; failure: AgentKeyFailure }
  | { kind: 'database-error'; error: string }
  | { kind: 'history'; agent: StoredAgent }
  | {
      kind: 'icebreaker';
      agent: StoredAgent;
      handle: ConnectHandle;
      outcome: MatchOutcome;
      consent: ConsentOutcome;
      icebreaker: IcebreakerHandle;
    }
  | {
      /** UI-03 — icebreaker failed; user can retry / skip / disconnect. */
      kind: 'icebreaker-error';
      agent: StoredAgent;
      handle: ConnectHandle;
      outcome: MatchOutcome;
      consent: ConsentOutcome;
      error: string;
    }
  | {
      kind: 'chat';
      agent: StoredAgent;
      handle: ConnectHandle;
      consent: ConsentOutcome;
      match: MatchOutcome;
      chat: ChatHandle;
      firstMessage?: string;
      firstMessageSource?: ChatMessageSource;
    };

function agentFromView(view: View): StoredAgent | null {
  if (
    view.kind === 'home' ||
    view.kind === 'edit' ||
    view.kind === 'settings' ||
    view.kind === 'blocked' ||
    view.kind === 'connect' ||
    view.kind === 'identify' ||
    view.kind === 'verify-peer' ||
    view.kind === 'consent' ||
    view.kind === 'match' ||
    view.kind === 'icebreaker' ||
    view.kind === 'icebreaker-error' ||
    view.kind === 'chat' ||
    view.kind === 'history'
  ) {
    return view.agent;
  }
  return null;
}

function flowStepForView(view: View): FlowStepId | undefined {
  switch (view.kind) {
    case 'connect':
      return 'connect';
    case 'identify':
    case 'verify-peer':
      return 'identify';
    case 'consent':
      return 'consent';
    case 'match':
      return 'match';
    case 'icebreaker':
    case 'icebreaker-error':
      return 'icebreaker';
    case 'chat':
      return 'chat';
    default:
      return undefined;
  }
}

function isConnectingView(view: View): boolean {
  return (
    view.kind === 'connect' ||
    view.kind === 'identify' ||
    view.kind === 'verify-peer' ||
    view.kind === 'consent' ||
    view.kind === 'match' ||
    view.kind === 'icebreaker' ||
    view.kind === 'icebreaker-error' ||
    view.kind === 'chat'
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ErrorBoundary>
        <AppRoot />
      </ErrorBoundary>
    </I18nProvider>
  );
}

function AppRoot() {
  const t = useTranslate();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({
    ready: false,
    reason: 'not_configured',
  });
  const [reloadToken, setReloadToken] = useState(0);
  const [demoReturn, setDemoReturn] = useState<View | null>(null);
  /** UI-02 — surface persistence failures instead of console-only. */
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);

  const refreshLlmStatus = useCallback(() => {
    void loadLlmStatus()
      .then(setLlmStatus)
      .catch((err: unknown) => {
        console.error('Kindora: could not read the saved LLM config.', err);
        setLlmStatus({ ready: false, reason: 'invalid_config' });
      });
  }, []);

  useEffect(() => {
    setView((current) => (current.kind === 'loading' ? current : { kind: 'loading' }));
    void loadAgent()
      .then((agent) => {
        setView(agent ? { kind: 'home', agent } : { kind: 'welcome' });
      })
      .catch((err: unknown) => {
        if (err instanceof DatabaseError) {
          console.error('Kindora: could not open the local database.', err);
          setView({ kind: 'database-error', error: err.message });
          return;
        }
        console.error('Kindora: could not load the agent private key.', err);
        setView({ kind: 'keychain-error', failure: classifyAgentKeyError(err) });
      });
    refreshLlmStatus();
  }, [refreshLlmStatus, reloadToken]);

  // Warn before closing the window mid-session (pairing → chat).
  useEffect(() => {
    const active =
      view.kind === 'connect' ||
      view.kind === 'identify' ||
      view.kind === 'verify-peer' ||
      view.kind === 'consent' ||
      view.kind === 'match' ||
      view.kind === 'icebreaker' ||
      view.kind === 'icebreaker-error' ||
      view.kind === 'chat';
    if (!active) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [view.kind]);

  const agent = agentFromView(view);
  const shellActive = agent !== null || (view.kind === 'demo' && demoReturn !== null && agentFromView(demoReturn) !== null);

  const navigate = useCallback(
    (id: NavId) => {
      if (view.kind === 'demo') {
        // Leaving demo via sidebar restores the prior screen first.
        const back = demoReturn;
        setDemoReturn(null);
        if (back && agentFromView(back)) {
          const a = agentFromView(back)!;
          if (id === 'home') setView({ kind: 'home', agent: a });
          else if (id === 'connect') setView({ kind: 'connect', agent: a });
          else if (id === 'history') setView({ kind: 'history', agent: a });
          else if (id === 'blocked') setView({ kind: 'blocked', agent: a });
          else if (id === 'settings') setView({ kind: 'settings', agent: a });
          else if (id === 'demo') setView({ kind: 'demo' });
          return;
        }
        setView({ kind: 'welcome' });
        return;
      }

      const a = agent;
      if (!a) {
        if (id === 'demo') {
          setDemoReturn({ kind: 'welcome' });
          setView({ kind: 'demo' });
        }
        return;
      }

      // Leaving an active session: disconnect before navigating away.
      if (isConnectingView(view) && 'handle' in view && id !== 'connect') {
        void view.handle.disconnect('user-navigate');
      }

      switch (id) {
        case 'home':
          setView({ kind: 'home', agent: a });
          break;
        case 'connect':
          setView({ kind: 'connect', agent: a });
          break;
        case 'history':
          setView({ kind: 'history', agent: a });
          break;
        case 'blocked':
          setView({ kind: 'blocked', agent: a });
          break;
        case 'settings':
          setView({ kind: 'settings', agent: a });
          break;
        case 'demo':
          setDemoReturn({ kind: 'home', agent: a });
          setView({ kind: 'demo' });
          break;
      }
    },
    [agent, demoReturn, view],
  );

  const shell = useMemo(
    () => ({
      active: navIdForViewKind(view.kind),
      agentName: agent?.profile.nickname || agent?.displayName,
      agentReady: agent !== null,
      connecting: isConnectingView(view),
      onNavigate: navigate,
    }),
    [agent, navigate, view],
  );

  const banner =
    persistenceNotice !== null ? (
      <Banner tone="error" testId="persistence-banner" onDismiss={() => setPersistenceNotice(null)}>
        {persistenceNotice}
      </Banner>
    ) : null;

  function withShell(children: ReactNode, opts?: { flush?: boolean; topBar?: ReactNode }) {
    return (
      <AppLayout
        sidebar={shell}
        flowStep={flowStepForView(view)}
        banner={banner}
        topBar={opts?.topBar}
        flush={opts?.flush}
      >
        {children}
      </AppLayout>
    );
  }

  if (view.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center text-sm text-kindora-500">
        {t('app.loading')}
      </main>
    );
  }

  if (view.kind === 'welcome') {
    return (
      <Welcome
        onCreate={() => setView({ kind: 'create' })}
        onTryDemo={() => {
          setDemoReturn({ kind: 'welcome' });
          setView({ kind: 'demo' });
        }}
      />
    );
  }

  if (view.kind === 'demo') {
    const demo = (
      <DemoView
        onExit={() => {
          const back = demoReturn;
          setDemoReturn(null);
          setView(back ?? { kind: 'welcome' });
        }}
      />
    );
    return shellActive ? withShell(demo) : demo;
  }

  if (view.kind === 'keychain-error') {
    return (
      <KeychainErrorScreen
        failure={view.failure}
        onRetry={() => setReloadToken((n) => n + 1)}
        onCreateNew={() => setView({ kind: 'create' })}
      />
    );
  }

  if (view.kind === 'database-error') {
    return (
      <DatabaseErrorScreen message={view.error} onRetry={() => setReloadToken((n) => n + 1)} />
    );
  }

  if (view.kind === 'create') {
    return (
      <CreateAgentForm
        variant="create"
        onSubmit={async (profile) => {
          const created = await createAgent(profile as SocialProfile);
          setView({ kind: 'home', agent: created });
        }}
      />
    );
  }

  // From here on an agent is required for the shell.
  if (!agent && view.kind !== 'edit') {
    return (
      <main className="kindora-page">
        <p className="kindora-muted">{t('app.loading')}</p>
      </main>
    );
  }

  if (view.kind === 'edit') {
    return withShell(
      <CreateAgentForm
        initialProfile={view.agent.profile}
        variant="edit"
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
        onSubmit={async (profile) => {
          const updated = await updateProfile(view.agent, profile as SocialProfile);
          setView({ kind: 'home', agent: updated });
        }}
      />,
    );
  }

  if (view.kind === 'settings') {
    return withShell(
      <Settings
        onClose={() => setView({ kind: 'home', agent: view.agent })}
        onSaved={refreshLlmStatus}
      />,
    );
  }

  if (view.kind === 'blocked') {
    return withShell(<BlockedAgentsScreen view={view} setView={setView} />);
  }

  if (view.kind === 'history') {
    return withShell(<ChatHistoryScreen view={view} setView={setView} />);
  }

  if (view.kind === 'connect') {
    const notReady = llmStatus.reason ? LLM_STATUS_KEYS[llmStatus.reason] : undefined;
    return withShell(
      <ConnectView
        llmReady={llmStatus.ready}
        llmNotReadyTitle={notReady ? t(notReady.title) : undefined}
        llmNotReadyBody={notReady ? t(notReady.body) : undefined}
        onConnected={(handle) => setView({ kind: 'identify', agent: view.agent, handle })}
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
      />,
    );
  }

  if (view.kind === 'identify') {
    return withShell(
      <>
        <LiveIdentifyView
          run={() => runIdentify(view.handle)}
          onDisconnect={() => {
            void view.handle.disconnect('user-disconnect');
            setView({ kind: 'home', agent: view.agent });
          }}
          onDone={(peer) => {
            void (async () => {
              const publicKey = peer.peerAgent?.publicKey;
              if (publicKey) {
                try {
                  await sessionNotePeer(peer.peerAgentId, publicKey);
                } catch (err) {
                  console.error('Kindora: session_note_peer failed', err);
                }
              }
              // Joiner already typed the host fingerprint (IBR-12); mark verified.
              // Host must confirm the joiner fingerprint before consent (IBR-5).
              if (view.handle.pairingRole === 'join') {
                try {
                  await sessionConfirmPeerFingerprint(view.handle.pairingCode);
                } catch (err) {
                  console.error('Kindora: session_confirm_peer_fingerprint failed', err);
                }
                if (view.handle.envelopeAuth) {
                  markPeerFingerprintVerified(view.handle.envelopeAuth);
                }
                setView({ kind: 'consent', agent: view.agent, handle: view.handle, peer });
                return;
              }
              setView({ kind: 'verify-peer', agent: view.agent, handle: view.handle, peer });
            })();
          }}
        />
      </>,
      {
        topBar: (
          <ConnectionStatusBar
            handle={view.handle}
            onLeave={() => setView({ kind: 'home', agent: view.agent })}
          />
        ),
      },
    );
  }

  if (view.kind === 'verify-peer') {
    return withShell(
      <PeerFingerprintConfirmView
        peer={view.peer}
        envelopeAuth={view.handle.envelopeAuth}
        onConfirmed={() =>
          setView({
            kind: 'consent',
            agent: view.agent,
            handle: view.handle,
            peer: view.peer,
          })
        }
        onDisconnect={() => {
          void view.handle.disconnect('user-disconnect');
          setView({ kind: 'home', agent: view.agent });
        }}
      />,
      {
        topBar: (
          <ConnectionStatusBar
            handle={view.handle}
            onLeave={() => setView({ kind: 'home', agent: view.agent })}
          />
        ),
      },
    );
  }

  if (view.kind === 'match') {
    return withShell(
      <LiveMatchView
        run={() => runExchangeAndMatch(view.handle, view.consent)}
        onDisconnect={() => {
          void view.handle.disconnect('user-disconnect');
          setView({ kind: 'home', agent: view.agent });
        }}
        onDone={(outcome) => {
          void runIcebreaker(outcome)
            .then((icebreaker) => {
              setView({
                kind: 'icebreaker',
                agent: view.agent,
                handle: view.handle,
                outcome,
                consent: view.consent,
                icebreaker,
              });
            })
            .catch((err: unknown) => {
              // UI-03 — do not silently drop the user into an empty chat.
              setView({
                kind: 'icebreaker-error',
                agent: view.agent,
                handle: view.handle,
                outcome,
                consent: view.consent,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }}
      />,
      {
        topBar: (
          <ConnectionStatusBar
            handle={view.handle}
            onLeave={() => setView({ kind: 'home', agent: view.agent })}
          />
        ),
      },
    );
  }

  if (view.kind === 'icebreaker-error') {
    return withShell(
      <IcebreakerErrorScreen
        message={view.error}
        onRetry={() => {
          void runIcebreaker(view.outcome)
            .then((icebreaker) => {
              setView({
                kind: 'icebreaker',
                agent: view.agent,
                handle: view.handle,
                outcome: view.outcome,
                consent: view.consent,
                icebreaker,
              });
            })
            .catch((err: unknown) => {
              setView({
                ...view,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }}
        onSkip={() => {
          const chat = runChat(view.handle, view.consent, '');
          setView({
            kind: 'chat',
            agent: view.agent,
            handle: view.handle,
            consent: view.consent,
            match: view.outcome,
            chat,
          });
        }}
        onDisconnect={() => {
          void view.handle.disconnect('user-disconnect');
          setView({ kind: 'home', agent: view.agent });
        }}
      />,
      {
        topBar: (
          <ConnectionStatusBar
            handle={view.handle}
            onLeave={() => setView({ kind: 'home', agent: view.agent })}
          />
        ),
      },
    );
  }

  if (view.kind === 'consent') {
    return withShell(<ConsentScreen view={view} setView={setView} />, {
      topBar: (
        <ConnectionStatusBar
          handle={view.handle}
          onLeave={() => setView({ kind: 'home', agent: view.agent })}
        />
      ),
    });
  }

  if (view.kind === 'icebreaker') {
    return withShell(<IcebreakerScreen view={view} setView={setView} />, {
      topBar: (
        <ConnectionStatusBar
          handle={view.handle}
          onLeave={() => setView({ kind: 'home', agent: view.agent })}
        />
      ),
    });
  }

  if (view.kind === 'chat') {
    return withShell(
      <ChatScreen
        view={view}
        setView={setView}
        onPersistenceError={() => setPersistenceNotice(t('app.persistenceError'))}
      />,
      {
        flush: true,
        topBar: (
          <ConnectionStatusBar
            handle={view.handle}
            onLeave={() => setView({ kind: 'home', agent: view.agent })}
          />
        ),
      },
    );
  }

  // view.kind === 'home'
  return withShell(
    <Home
      agent={view.agent}
      onEdit={() => setView({ kind: 'edit', agent: view.agent })}
      onConnect={() => setView({ kind: 'connect', agent: view.agent })}
      onSettings={() => setView({ kind: 'settings', agent: view.agent })}
      onBlocked={() => setView({ kind: 'blocked', agent: view.agent })}
      onHistory={() => setView({ kind: 'history', agent: view.agent })}
      onTryDemo={() => {
        setDemoReturn({ kind: 'home', agent: view.agent });
        setView({ kind: 'demo' });
      }}
    />,
  );
}

function IcebreakerErrorScreen({
  message,
  onRetry,
  onSkip,
  onDisconnect,
}: {
  message: string;
  onRetry: () => void;
  onSkip: () => void;
  onDisconnect: () => void;
}) {
  const t = useTranslate();
  return (
    <main className="kindora-page" data-testid="icebreaker-error">
      <section className="kindora-card">
        <p className="kindora-eyebrow">{t('common.error')}</p>
        <h1 className="kindora-title mt-2">{t('app.icebreakerErrorTitle')}</h1>
        <p className="kindora-muted mt-3">{t('app.icebreakerErrorBody')}</p>
        <pre className="mt-4 max-h-32 overflow-auto rounded-md border border-kindora-700 bg-kindora-950 p-3 font-mono text-xs text-rose-300">
          {message}
        </pre>
        <div className="mt-6 flex flex-wrap gap-2">
          <button type="button" className="kindora-button" onClick={onRetry}>
            {t('app.icebreakerRetry')}
          </button>
          <button type="button" className="kindora-button-ghost" onClick={onSkip}>
            {t('app.icebreakerSkip')}
          </button>
          <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
            {t('common.cancel')}
          </button>
        </div>
      </section>
    </main>
  );
}

function DatabaseErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslate();
  return (
    <main className="kindora-page">
      <section className="kindora-card">
        <h1 className="kindora-title">{t('app.databaseErrorTitle')}</h1>
        <p className="kindora-muted mt-2">{message}</p>
        <button type="button" className="kindora-button mt-6" onClick={onRetry}>
          {t('app.databaseErrorRetry')}
        </button>
      </section>
    </main>
  );
}

function ChatHistoryScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'history' }>;
  setView: (v: View) => void;
}) {
  const [sessions, setSessions] = useState<readonly ChatHistorySession[]>([]);
  const [transcript, setTranscript] = useState<readonly StoredChatMessage[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(() => {
    setLoading(true);
    void listChatHistory()
      .then((list) => {
        setSessions(list);
        setError(undefined);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const select = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    void loadChatTranscript(sessionId)
      .then(setTranscript)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  return (
    <>
      {error && (
        <div className="px-6 pt-4">
          <Banner tone="error" testId="history-error">
            {error}
          </Banner>
        </div>
      )}
      <ChatHistoryView
        sessions={sessions}
        transcript={transcript}
        selectedSessionId={selectedSessionId}
        loading={loading}
        unavailable={!isChatHistoryAvailable()}
        selfDisplayName={view.agent.displayName}
        onSelect={select}
        onClose={() => setView({ kind: 'home', agent: view.agent })}
      />
    </>
  );
}

function BlockedAgentsScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'blocked' }>;
  setView: (v: View) => void;
}) {
  const [entries, setEntries] = useState<readonly BlockedAgent[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    void getBlockedAgentsStore()
      .list()
      .then((list) => setEntries(list))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <BlockedAgentsView
      entries={loading ? [] : entries}
      onUnblock={async (agentId) => {
        await getBlockedAgentsStore().remove(agentId);
        reload();
      }}
      onClose={() => setView({ kind: 'home', agent: view.agent })}
    />
  );
}

function ConnectionStatusBar({
  handle,
  onLeave,
}: {
  handle: ConnectHandle;
  /** Return home after a dead peer / failed link when reconnect is unavailable. */
  onLeave?: () => void;
}) {
  const t = useTranslate();
  const [state, setState] = useState<ConnectionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!handle.connectionState) return undefined;
    setState(handle.connectionState());
    if (!handle.onConnectionStateChange) return undefined;
    return handle.onConnectionStateChange((next) => {
      setState(next);
    });
  }, [handle]);

  if (!state) return null;

  const reconnect = handle.reconnect;
  const linkGone = state === 'disconnected' || state === 'failed';

  return (
    <div className="flex items-center justify-between gap-3 border-b border-kindora-200 bg-white px-6 py-2.5">
      <ConnectionStatus
        state={state}
        error={error}
        onReconnect={
          reconnect
            ? () => {
                setError(null);
                void reconnect().catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : String(e));
                });
              }
            : undefined
        }
      />
      {linkGone && onLeave && !reconnect && (
        <button
          type="button"
          className="kindora-button-ghost text-xs"
          data-testid="connection-leave-home"
          onClick={() => {
            void handle.disconnect('peer-link-gone');
            onLeave();
          }}
        >
          {t('connect.leaveToHome')}
        </button>
      )}
    </div>
  );
}

const KEYCHAIN_ERROR_COPY: Record<
  AgentKeyFailure['kind'],
  { readonly body: TranslationKey; readonly hint: TranslationKey }
> = {
  keychain_locked: {
    body: 'app.keychainError.locked',
    hint: 'app.keychainError.lockedHint',
  },
  keychain_denied: {
    body: 'app.keychainError.denied',
    hint: 'app.keychainError.deniedHint',
  },
  keychain_unavailable: {
    body: 'app.keychainError.unavailable',
    hint: 'app.keychainError.unavailableHint',
  },
  not_found: {
    body: 'app.keychainError.notFound',
    hint: 'app.keychainError.notFoundHint',
  },
  corrupt: {
    body: 'app.keychainError.corrupt',
    hint: 'app.keychainError.corruptHint',
  },
  invalid_key: {
    body: 'app.keychainError.invalidKey',
    hint: 'app.keychainError.invalidKeyHint',
  },
  keyring: {
    body: 'app.keychainError.generic',
    hint: 'app.keychainError.genericHint',
  },
  unknown: {
    body: 'app.keychainError.generic',
    hint: 'app.keychainError.genericHint',
  },
};

function KeychainErrorScreen({
  failure,
  onRetry,
  onCreateNew,
}: {
  failure: AgentKeyFailure;
  onRetry: () => void;
  onCreateNew: () => void;
}) {
  const t = useTranslate();
  const copy = KEYCHAIN_ERROR_COPY[failure.kind] ?? KEYCHAIN_ERROR_COPY.unknown;
  const offerCreateNew =
    failure.kind === 'not_found' || failure.kind === 'corrupt' || failure.kind === 'invalid_key';
  return (
    <main className="kindora-page">
      <section className="kindora-card" data-testid="keychain-error-screen">
        <h1 className="kindora-title">{t('app.keychainErrorTitle')}</h1>
        <p className="kindora-muted mt-2" data-testid="keychain-error-body">
          {t(copy.body)}
        </p>
        <p
          className="text-kindora-600 dark:text-kindora-300 mt-3 text-sm"
          data-testid="keychain-error-hint"
        >
          {t(copy.hint)}
        </p>
        {failure.kind === 'unknown' || failure.kind === 'keyring' ? (
          <p className="kindora-muted mt-3 font-mono text-xs" data-testid="keychain-error-detail">
            {failure.message}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            type="button"
            className="kindora-button"
            data-testid="keychain-error-retry"
            onClick={onRetry}
          >
            {t('app.keychainErrorRetry')}
          </button>
          {offerCreateNew ? (
            <button
              type="button"
              className="kindora-button-ghost"
              data-testid="keychain-error-create-new"
              onClick={onCreateNew}
            >
              {t('app.keychainError.createNew')}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function ChatScreen({
  view,
  setView,
  onPersistenceError,
}: {
  view: Extract<View, { kind: 'chat' }>;
  setView: (v: View) => void;
  onPersistenceError: () => void;
}) {
  const [chat] = useState(() =>
    runChat(view.handle, view.consent, view.firstMessage ?? '', view.firstMessageSource ?? 'human'),
  );
  const [chatAssist, setChatAssist] = useState<ChatAssistHandle | null>(null);
  const [chatAssistError, setChatAssistError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void runChatAssist(chat, view.consent, view.match)
      .then((handle) => setChatAssist(handle))
      .catch((e: unknown) => {
        setChatAssistError(e instanceof Error ? e.message : String(e));
      });
  }, [chat, view.consent, view.match]);

  // UI-02 — if the orchestrator reports a persistence failure via console
  // path, also watch send failures that mention persistence. The chat
  // port rejects; LiveChatView surfaces `error`. We additionally listen
  // for window-level custom events fired by a patched send wrapper.
  useEffect(() => {
    const handler = () => onPersistenceError();
    window.addEventListener('kindora:persistence-error', handler);
    return () => window.removeEventListener('kindora:persistence-error', handler);
  }, [onPersistenceError]);

  function exit(): void {
    void view.handle.disconnect('chat-closed');
    setView({ kind: 'home', agent: view.agent });
  }

  return (
    <LiveChatView
      peerDisplayName={view.consent.peerDisplayName}
      selfDisplayName={view.agent.displayName}
      initialDraft={chat.firstMessage}
      initialDraftSource={chat.firstMessageSource}
      maxTextLength={2000}
      run={() => chat.orchestrator.start(view.handle.session)}
      subscribe={(listener) => chat.subscribe(listener)}
      onSend={async (text, source) => {
        try {
          await chat.orchestrator.send(view.handle.session, text, source ?? 'human');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/persist|database|sqlite|storage/i.test(msg)) {
            onPersistenceError();
          }
          throw err;
        }
      }}
      onDisconnect={async () => {
        await chat.orchestrator.disconnect(view.handle.session, 'user-disconnect');
        exit();
      }}
      onBlock={async () => {
        await chat.orchestrator.block(view.handle.session, 'user-block');
        exit();
      }}
      chatAssist={chatAssist}
      chatAssistError={chatAssistError}
    />
  );
}

function ConsentScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'consent' }>;
  setView: (v: View) => void;
}) {
  const [consent] = useState(() => runConsent(view.handle, view.peer));
  return (
    <LiveConsentView
      peer={view.peer}
      start={() => consent.orchestrator.start(view.handle.session)}
      decide={(decision, note) => consent.orchestrator.decide(view.handle.session, decision, note)}
      onDisconnect={() => {
        void view.handle.disconnect('user-disconnect');
        setView({ kind: 'home', agent: view.agent });
      }}
      onFinal={(finalOutcome) => {
        if (finalOutcome.state === 'accepted_both') {
          void (async () => {
            try {
              await sessionSetMutualConsent();
              await sessionAdvanceChat();
            } catch (err) {
              console.error('Kindora: session consent/chat advance failed', err);
            }
            if (view.handle.envelopeAuth) {
              markMutualConsent(view.handle.envelopeAuth);
              markChatPhase(view.handle.envelopeAuth);
            }
            setView({
              kind: 'match',
              agent: view.agent,
              handle: view.handle,
              peer: view.peer,
              consent: finalOutcome,
            });
          })();
        } else {
          void view.handle.disconnect('consent-closed');
        }
      }}
    />
  );
}

function IcebreakerScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'icebreaker' }>;
  setView: (v: View) => void;
}) {
  const icebreaker = view.icebreaker;

  function enterChat(firstMessage?: string): void {
    const chat = runChat(view.handle, view.consent, firstMessage ?? '', 'agent');
    setView({
      kind: 'chat',
      agent: view.agent,
      handle: view.handle,
      consent: view.consent,
      match: view.outcome,
      chat,
      ...(firstMessage !== undefined ? { firstMessage, firstMessageSource: 'agent' as const } : {}),
    });
  }

  return (
    <LiveIcebreakerView
      peerDisplayName={view.consent.peerDisplayName}
      selfDisplayName={view.agent.displayName}
      input={icebreaker.input}
      generate={() => icebreaker.generate()}
      onUse={(chosen) => {
        enterChat(chosen);
      }}
      onSkip={() => enterChat()}
      onDisconnect={() => {
        void view.handle.disconnect('user-disconnect');
        setView({ kind: 'home', agent: view.agent });
      }}
    />
  );
}
