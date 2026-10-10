import { useEffect, useState } from 'react';
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
import type { ChatHandle, IcebreakerHandle } from './lib/connect-service';
import type { ConnectHandle } from './lib/connect-service';
import {
  runChat,
  runConsent,
  runIcebreaker,
  runMatch,
  refreshBlockListSnapshot,
} from './lib/connect-service';
import { createAgent, loadAgent, updateProfile } from './lib/agent-service';
import { loadProvider } from './lib/llm-service';

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
      chat: ChatHandle;
      firstMessage?: string;
    };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [llmReady, setLlmReady] = useState(false);

  useEffect(() => {
    void loadAgent().then((agent) => {
      setView(agent ? { kind: 'home', agent } : { kind: 'welcome' });
    });
    void loadProvider().then((p) => setLlmReady(p !== null));
    void refreshBlockListSnapshot();
  }, []);

  if (view.kind === 'loading') {
    return (
      <main className="text-kindora-500 flex h-full items-center justify-center text-sm">
        Loading…
      </main>
    );
  }

  if (view.kind === 'welcome') {
    return <Welcome onCreate={() => setView({ kind: 'create' })} />;
  }

  if (view.kind === 'create') {
    return (
      <CreateAgentForm
        submitLabel="Create Agent"
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
        submitLabel="Save"
        onCancel={() => setView({ kind: 'home', agent: view.agent })}
        onSubmit={async (profile) => {
          const updated = await updateProfile(view.agent, profile as SocialProfile);
          setView({ kind: 'home', agent: updated });
        }}
      />
    );
  }

  if (view.kind === 'settings') {
    return <Settings onClose={() => setView({ kind: 'home', agent: view.agent })} />;
  }

  if (view.kind === 'connect') {
    return (
      <ConnectView
        llmReady={llmReady}
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
