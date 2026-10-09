import { useEffect, useState } from 'react';
import type { SocialProfile } from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';
import { Welcome } from './views/Welcome';
import { CreateAgentForm } from './views/CreateAgentForm';
import { Home } from './views/Home';
import { Settings } from './views/Settings';
import { ConnectView } from './views/ConnectView';
import { LiveMatchView } from './views/MatchView';
import type { ConnectHandle } from './lib/connect-service';
import { runMatch } from './lib/connect-service';
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
  | { kind: 'match'; agent: StoredAgent; handle: ConnectHandle };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [llmReady, setLlmReady] = useState(false);

  useEffect(() => {
    void loadAgent().then((agent) => {
      setView(agent ? { kind: 'home', agent } : { kind: 'welcome' });
    });
    void loadProvider().then((p) => setLlmReady(p !== null));
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
