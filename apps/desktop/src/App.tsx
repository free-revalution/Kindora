import { useCallback, useEffect, useState } from 'react';
import type { SocialProfile } from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';
import { Welcome } from './views/Welcome';
import { CreateAgentForm } from './views/CreateAgentForm';
import { Home } from './views/Home';
import { Settings } from './views/Settings';
import { ConnectView } from './views/ConnectView';
import { LiveMatchView } from './views/MatchView';
import { LiveConsentView } from './views/ConsentView';
import { LiveIcebreakerView } from './views/IcebreakerView';
import { LiveChatView } from './views/ChatView';
import type { ConsentOutcome, MatchOutcome } from '@kindora/matching';
import type { ChatAssistHandle, ChatHandle, IcebreakerHandle } from './lib/connect-service';
import type { ConnectHandle } from './lib/connect-service';
import {
  runChat,
  runChatAssist,
  runConsent,
  runIcebreaker,
  runMatch,
  refreshBlockListSnapshot,
} from './lib/connect-service';
import { createAgent, loadAgent, updateProfile } from './lib/agent-service';
import { loadLlmStatus, type LlmStatus } from './lib/llm-service';
import { useTranslate, I18nProvider, LLM_STATUS_KEYS } from './i18n';

type View =
  | { kind: 'loading' }
  | { kind: 'welcome' }
  | { kind: 'create' }
  | { kind: 'edit'; agent: StoredAgent }
  | { kind: 'home'; agent: StoredAgent }
  | { kind: 'settings'; agent: StoredAgent }
  | { kind: 'connect'; agent: StoredAgent }
  | { kind: 'match'; agent: StoredAgent; handle: ConnectHandle }
  | {
      kind: 'consent';
      agent: StoredAgent;
      handle: ConnectHandle;
      outcome: MatchOutcome;
    }
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
    void loadAgent().then((agent) => {
      setView(agent ? { kind: 'home', agent } : { kind: 'welcome' });
    });
    refreshLlmStatus();
    void refreshBlockListSnapshot();
  }, [refreshLlmStatus]);

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

  if (view.kind === 'connect') {
    const notReady = llmStatus.reason ? LLM_STATUS_KEYS[llmStatus.reason] : undefined;
    return (
      <ConnectView
        llmReady={llmStatus.ready}
        llmNotReadyTitle={notReady ? t(notReady.title) : undefined}
        llmNotReadyBody={notReady ? t(notReady.body) : undefined}
        onConnected={(handle) => setView({ kind: 'match', agent: view.agent, handle })}
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
      />
    );
  }

  if (view.kind === 'match') {
    return (
      <LiveMatchView
        run={() => runMatch(view.handle)}
        onDisconnect={() => {
          void view.handle.disconnect('user-disconnect');
          setView({ kind: 'home', agent: view.agent });
        }}
        onDone={(outcome) => {
          setView({ kind: 'consent', agent: view.agent, handle: view.handle, outcome });
        }}
      />
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
    />
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
  const [chat] = useState(() => runChat(view.handle, view.consent, view.firstMessage ?? ''));
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
    void refreshBlockListSnapshot();
    setView({ kind: 'home', agent: view.agent });
  }

  return (
    <LiveChatView
      peerDisplayName={view.consent.peerDisplayName}
      selfDisplayName={view.agent.displayName}
      initialDraft={chat.firstMessage}
      maxTextLength={2000}
      run={() => chat.orchestrator.start(view.handle.session)}
      subscribe={(listener) => chat.subscribe(listener)}
      onSend={async (text) => {
        await chat.orchestrator.send(view.handle.session, text);
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
  const [consent] = useState(() => runConsent(view.handle, view.outcome));
  return (
    <LiveConsentView
      outcome={view.outcome}
      start={() => consent.orchestrator.start(view.handle.session)}
      decide={(decision, note) => consent.orchestrator.decide(view.handle.session, decision, note)}
      onDisconnect={() => {
        void view.handle.disconnect('user-disconnect');
        setView({ kind: 'home', agent: view.agent });
      }}
      onFinal={(finalOutcome) => {
        if (finalOutcome.state === 'accepted_both') {
          // Build the icebreaker handle lazily. If it fails (no agent
          // or no LLM), fall through to a chat screen so the user
          // isn't stranded — they can still type and send.
          void runIcebreaker(view.outcome)
            .then((icebreaker) => {
              setView({
                kind: 'icebreaker',
                agent: view.agent,
                handle: view.handle,
                outcome: view.outcome,
                consent: finalOutcome,
                icebreaker,
              });
            })
            .catch(() => {
              const chat = runChat(view.handle, finalOutcome, '');
              setView({
                kind: 'chat',
                agent: view.agent,
                handle: view.handle,
                consent: finalOutcome,
                match: view.outcome,
                chat,
              });
            });
        } else {
          // rejected / blocked: keep the user on the consent screen
          // so they see the final banner, then they click "Close"
          // to go home.
          void refreshBlockListSnapshot();
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
    const chat = runChat(view.handle, view.consent, firstMessage ?? '');
    setView({
      kind: 'chat',
      agent: view.agent,
      handle: view.handle,
      consent: view.consent,
      match: view.outcome,
      chat,
      ...(firstMessage !== undefined ? { firstMessage } : {}),
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
