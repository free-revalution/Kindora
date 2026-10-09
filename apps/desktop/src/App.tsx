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
import type { ConsentOutcome, MatchOutcome } from '@kindora/matching';
import type { ConnectHandle } from './lib/connect-service';
import {
  runConsent,
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
      kind: 'chat';
      agent: StoredAgent;
      handle: ConnectHandle;
      consent: ConsentOutcome;
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

  if (view.kind === 'chat') {
    return (
      <ChatStub
        agentName={view.agent.displayName}
        peerName={view.consent.peerDisplayName}
        onClose={() => {
          void view.handle.disconnect('chat-closed');
          setView({ kind: 'home', agent: view.agent });
        }}
      />
    );
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
 * Phase 9 placeholder. Real chat (Send / Receive / History / Block /
 * Disconnect) lands in Phase 9. For now this just confirms the
 * consent-unlocked handoff.
 */
function ChatStub({
  agentName,
  peerName,
  onClose,
}: {
  agentName: string;
  peerName: string;
  onClose: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
            Chat with
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{peerName}</h1>
          <p className="text-kindora-500 dark:text-kindora-400 mt-1 text-sm">
            You: {agentName}
          </p>
        </div>
        <button type="button" className="kindora-button-ghost" onClick={onClose}>
          Close
        </button>
      </header>
      <section className="kindora-card flex flex-col gap-3">
        <h2 className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          Phase 9 — coming soon
        </h2>
        <p className="text-sm leading-relaxed">
          Both you and {peerName} accepted. The chat is unlocked. Real text chat, AI
          assist, and icebreaker generation land in Phase 9.
        </p>
      </section>
    </main>
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
          setView({ kind: 'chat', agent: view.agent, handle: view.handle, consent: finalOutcome });
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
