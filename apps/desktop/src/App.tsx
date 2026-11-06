import { useCallback, useEffect, useState } from 'react';
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
import { LiveConsentView } from './views/ConsentView';
import { LiveIcebreakerView } from './views/IcebreakerView';
import { LiveChatView } from './views/ChatView';
import { BlockedAgentsView } from './views/BlockedAgentsView';
import { ChatHistoryView } from './views/ChatHistoryView';
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
import { createAgent, describeAgentKeyError, loadAgent, updateProfile } from './lib/agent-service';
import { loadLlmStatus, type LlmStatus } from './lib/llm-service';
import { useTranslate, I18nProvider, LLM_STATUS_KEYS } from './i18n';

/**
 * The screens of the app.
 *
 * ## Phase B — the order of the screens changed
 *
 * Before Phase B the flow was: connect → **match** → consent →
 * icebreaker → chat. The match ran *before* the user had agreed to
 * talk to the peer, which meant the peer's full profile was already
 * on the wire when the consent screen appeared.
 *
 * Task book § 五 B2 reverses it: connect → **identify** (exchange the
 * public cards) → **consent** (the human decides) → **match** (the
 * authorised profiles are exchanged and analysed) → icebreaker → chat.
 *
 * The `match` screen therefore carries a `consent` — it is the proof
 * that the disclosure was authorised — and the `consent` screen
 * carries a `peer` (the public card), not a `MatchOutcome`.
 */
type View =
  | { kind: 'loading' }
  | { kind: 'welcome' }
  | { kind: 'create' }
  | { kind: 'edit'; agent: StoredAgent }
  | { kind: 'home'; agent: StoredAgent }
  | { kind: 'settings'; agent: StoredAgent }
  | { kind: 'blocked'; agent: StoredAgent }
  | { kind: 'connect'; agent: StoredAgent }
  | { kind: 'identify'; agent: StoredAgent; handle: ConnectHandle }
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
  | { kind: 'keychain-error'; error: string }
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
      kind: 'chat';
      agent: StoredAgent;
      handle: ConnectHandle;
      consent: ConsentOutcome;
      match: MatchOutcome;
      chat: ChatHandle;
      firstMessage?: string;
      /**
       * Phase D / D2 — who wrote the first message. The icebreaker is
       * written by the LLM, so it is `agent`.
       */
      firstMessageSource?: ChatMessageSource;
    };

export default function App() {
  // `App` owns the provider rather than `main.tsx`. That way every entry point
  // — the real window and every test that renders `<App />` — is wired for
  // translations by construction, and `useI18n()`'s "no provider" warning
  // becomes a real signal instead of routine noise.
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const t = useTranslate();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({
    ready: false,
    reason: 'not_configured',
  });
  /**
   * Bumped by the "Try again" button on the keychain-error screen so
   * that the agent is loaded again from scratch.
   */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * Re-read the saved LLM configuration.
   *
   * This has to be a callback the Settings screen can trigger, not a one-off
   * read at startup: the Connect screen gates on `llmStatus.ready`, and the
   * only way a user configures an LLM is by saving it in Settings while the
   * app is already running. Reading once at mount meant a successful save
   * changed nothing until the app was restarted — the save banner said
   * "Saved" while the app still believed there was no LLM.
   */
  const refreshLlmStatus = useCallback(() => {
    void loadLlmStatus()
      .then(setLlmStatus)
      .catch((err: unknown) => {
        // A broken config is a state to report, not a crash. `loadLlmStatus`
        // never throws, so this is belt-and-braces.
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
        // Phase D / D1 — a broken database is a different problem from
        // a missing private key, and it deserves its own screen: the
        // message says what went wrong and the button retries.
        if (err instanceof DatabaseError) {
          console.error('Kindora: could not open the local database.', err);
          setView({ kind: 'database-error', error: err.message });
          return;
        }
        // The private key could not be recovered. This is a state to
        // report, not a crash — and it is emphatically *not* a licence
        // to fall back to a plaintext key or to mint a new identity.
        console.error('Kindora: could not load the agent private key.', err);
        setView({ kind: 'keychain-error', error: describeAgentKeyError(err) });
      });
    refreshLlmStatus();
  }, [refreshLlmStatus, reloadToken]);

  if (view.kind === 'loading') {
    return (
      <main className="text-kindora-500 flex h-full items-center justify-center text-sm">
        {t('app.loading')}
      </main>
    );
  }

  if (view.kind === 'welcome') {
    return <Welcome onCreate={() => setView({ kind: 'create' })} />;
  }

  if (view.kind === 'keychain-error') {
    return (
      <KeychainErrorScreen message={view.error} onRetry={() => setReloadToken((n) => n + 1)} />
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
          const agent = await createAgent(profile as SocialProfile);
          setView({ kind: 'home', agent });
        }}
      />
    );
  }

  if (view.kind === 'edit') {
    return (
      <CreateAgentForm
        initialProfile={view.agent.profile}
        variant="edit"
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
        onSubmit={async (profile) => {
          const updated = await updateProfile(view.agent, profile as SocialProfile);
          setView({ kind: 'home', agent: updated });
        }}
      />
    );
  }

  if (view.kind === 'settings') {
    return (
      <Settings
        onClose={() => setView({ kind: 'home', agent: view.agent })}
        onSaved={refreshLlmStatus}
      />
    );
  }

  if (view.kind === 'blocked') {
    return <BlockedAgentsScreen view={view} setView={setView} />;
  }

  if (view.kind === 'history') {
    return <ChatHistoryScreen view={view} setView={setView} />;
  }

  if (view.kind === 'connect') {
    const notReady = llmStatus.reason ? LLM_STATUS_KEYS[llmStatus.reason] : undefined;
    return (
      <ConnectView
        llmReady={llmStatus.ready}
        llmNotReadyTitle={notReady ? t(notReady.title) : undefined}
        llmNotReadyBody={notReady ? t(notReady.body) : undefined}
        onConnected={(handle) => setView({ kind: 'identify', agent: view.agent, handle })}
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
      />
    );
  }

  if (view.kind === 'identify') {
    return (
      <>
        <ConnectionStatusBar handle={view.handle} />
        <LiveIdentifyView
          run={() => runIdentify(view.handle)}
          onDisconnect={() => {
            void view.handle.disconnect('user-disconnect');
            setView({ kind: 'home', agent: view.agent });
          }}
          onDone={(peer) =>
            setView({ kind: 'consent', agent: view.agent, handle: view.handle, peer })
          }
        />
      </>
    );
  }

  if (view.kind === 'match') {
    return (
      <>
        <ConnectionStatusBar handle={view.handle} />
        <LiveMatchView
          run={() => runExchangeAndMatch(view.handle, view.consent)}
          onDisconnect={() => {
            void view.handle.disconnect('user-disconnect');
            setView({ kind: 'home', agent: view.agent });
          }}
          onDone={(outcome) => {
            // Phase B: the match only runs once both sides accepted, so
            // the icebreaker can be built from the outcome directly.
            // If it cannot be built (no agent / no LLM), fall through
            // to a chat screen so the user isn't stranded — they can
            // still type and send.
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
              .catch(() => {
                const chat = runChat(view.handle, view.consent, '');
                setView({
                  kind: 'chat',
                  agent: view.agent,
                  handle: view.handle,
                  consent: view.consent,
                  match: outcome,
                  chat,
                });
              });
          }}
        />
      </>
    );
  }

  if (view.kind === 'consent') {
    return <ConsentScreen view={view} setView={setView} />;
  }

  if (view.kind === 'icebreaker') {
    return <IcebreakerScreen view={view} setView={setView} />;
  }

  if (view.kind === 'chat') {
    return <ChatScreen view={view} setView={setView} />;
  }

  // view.kind === 'home'
  return (
    <Home
      agent={view.agent}
      onEdit={() => setView({ kind: 'edit', agent: view.agent })}
      onConnect={() => setView({ kind: 'connect', agent: view.agent })}
      onSettings={() => setView({ kind: 'settings', agent: view.agent })}
      onBlocked={() => setView({ kind: 'blocked', agent: view.agent })}
      onHistory={() => setView({ kind: 'history', agent: view.agent })}
    />
  );
}

/**
 * Phase D / D1 — the local database could not be opened.
 *
 * The message says what happened and what was *not* changed: the
 * database is only ever written to, so a failed open means the data
 * is still exactly where it was. "Try again" re-opens it — the failed
 * attempt is not cached.
 */
function DatabaseErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslate();
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-16">
      <section className="kindora-card">
        <h1 className="text-xl font-semibold tracking-tight">{t('app.databaseErrorTitle')}</h1>
        <p className="mt-2 text-sm leading-relaxed">{message}</p>
        <button type="button" className="kindora-button mt-6" onClick={onRetry}>
          {t('app.databaseErrorRetry')}
        </button>
      </section>
    </main>
  );
}

/**
 * Phase D / D2 — the chat history.
 *
 * The conversations of this device, newest first, and the transcript
 * of the selected one. The data comes from the local database; the
 * browser dev server has none, and the screen says so.
 */
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
        <div className="mx-auto w-full max-w-2xl px-6 pt-4">
          <p className="text-sm text-rose-600 dark:text-rose-400" data-testid="history-error">
            {error}
          </p>
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

/**
 * Phase B / B3 — the blocked-agents screen.
 *
 * The list is read from the store (localStorage) and re-read after
 * every change, so what is shown is what is actually persisted. The
 * pairing guard reads the same store, so an unblock here takes effect
 * on the very next pairing attempt — there is no separate cache to
 * invalidate.
 */
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

/**
 * Phase C / C3 § 8 — the connection lifecycle, shown above the match
 * screen.
 *
 * The in-process loopback path has no "the peer went away" event, so
 * it does not report a connection state and the bar simply does not
 * appear there. The LAN path does report one, and this is where the
 * user sees 连接中 / 已连接 / 断开 / 重连中 / 失败 — and where they
 * can ask for a reconnect.
 */
function ConnectionStatusBar({ handle }: { handle: ConnectHandle }) {
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

  // Captured in a local so the closure does not depend on narrowing
  // that TypeScript does not carry into callbacks.
  const reconnect = handle.reconnect;

  return (
    <div className="border-kindora-200 dark:border-kindora-700 mx-auto flex w-full max-w-2xl items-center justify-between gap-3 border-b px-6 py-3">
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
    </div>
  );
}

/**
 * Phase A / A1 — the agent's private key could not be recovered from the
 * OS keychain.
 *
 * We say so plainly instead of quietly continuing without a key: a
 * session that cannot sign is not a session the user thinks it is.
 */
function KeychainErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useTranslate();
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-16">
      <section className="kindora-card">
        <h1 className="text-xl font-semibold tracking-tight">{t('app.keychainErrorTitle')}</h1>
        <p className="mt-2 text-sm leading-relaxed">{message}</p>
        <button type="button" className="kindora-button mt-6" onClick={onRetry}>
          {t('app.keychainErrorRetry')}
        </button>
      </section>
    </main>
  );
}

/**
 * Phase 9 — Chat screen. Owns a single ChatOrchestrator built lazily
 * by `runChat()`. Subscribes to its snapshot so the view re-renders
 * when messages arrive or the session closes. The chosen icebreaker
 * (if any) is rendered as `initialDraft` — the user still has to click
 * Send; per § 32 the AI never auto-sends, and "Use" doesn't bypass
 * the human's final click.
 */
function ChatScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'chat' }>;
  setView: (v: View) => void;
}) {
  // Build the chat handle once for this (consent outcome, first
  // message) pair. Recreating it would lose the entry history.
  const [chat] = useState(() =>
    runChat(view.handle, view.consent, view.firstMessage ?? '', view.firstMessageSource ?? 'human'),
  );
  // Phase 10 — "Ask My Agent" handle. Built lazily so a missing LLM
  // doesn't break the whole chat screen; if it fails, the user just
  // doesn't see the assistant panel.
  const [chatAssist, setChatAssist] = useState<ChatAssistHandle | null>(null);
  const [chatAssistError, setChatAssistError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void runChatAssist(chat, view.consent, view.match)
      .then((handle) => setChatAssist(handle))
      .catch((e: unknown) => {
        setChatAssistError(e instanceof Error ? e.message : String(e));
      });
  }, [chat, view.consent, view.match]);

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
        await chat.orchestrator.send(view.handle.session, text, source ?? 'human');
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

/* ------------------------------------------------------------------ */
/* Consent screen — owns the orchestrator lifecycle for the consent    */
/* phase. Created lazily once per (handle, outcome) pair so the        */
/* underlying state machine stays stable across re-renders.            */
/* ------------------------------------------------------------------ */

function ConsentScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'consent' }>;
  setView: (v: View) => void;
}) {
  // Lazy init — the orchestrator is created exactly once for this
  // consent screen, then kept stable across renders. Recreating it
  // would lose the peer-decision state.
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
          // Phase B: only now may the authorised profiles be exchanged.
          // The match screen is the first point in the flow where the
          // peer's full (authorised) profile crosses the wire.
          setView({
            kind: 'match',
            agent: view.agent,
            handle: view.handle,
            peer: view.peer,
            consent: finalOutcome,
          });
        } else {
          // rejected / blocked: the connection is over. Tear it down,
          // and leave the user on the consent screen so they can read
          // the final banner before closing it.
          void view.handle.disconnect('consent-closed');
        }
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Icebreaker screen — owns the LLM call for Phase 8. Created lazily    */
/* once per (consent outcome, match outcome) pair so the agent-runtime  */
/* config stays stable. The view itself owns a single `generate()`     */
/* call and is re-callable via Regenerate.                              */
/* ------------------------------------------------------------------ */

function IcebreakerScreen({
  view,
  setView,
}: {
  view: Extract<View, { kind: 'icebreaker' }>;
  setView: (v: View) => void;
}) {
  // `view.icebreaker` was built once by the parent; we re-use the
  // same handle across re-renders. (The view only invokes `generate`
  // again on Regenerate.)
  const icebreaker = view.icebreaker;

  function enterChat(firstMessage?: string): void {
    // Phase D / D2 — the icebreaker was written by the LLM, so the
    // message is recorded as agent-sourced when the user sends it.
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
