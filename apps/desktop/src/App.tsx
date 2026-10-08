/**
 * App shell — chooses Welcome / Create / Edit / Home based on state.
 */

import { useEffect, useState } from 'react';
import type { SocialProfile } from '@kindora/protocol';
import type { StoredAgent } from '@kindora/storage';
import { Welcome } from './views/Welcome';
import { CreateAgentForm } from './views/CreateAgentForm';
import { Home } from './views/Home';
import { createAgent, loadAgent, updateProfile } from './lib/agent-service';

type View =
  | { kind: 'loading' }
  | { kind: 'welcome' }
  | { kind: 'create' }
  | { kind: 'edit'; agent: StoredAgent }
  | { kind: 'home'; agent: StoredAgent };

export default function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  useEffect(() => {
    void loadAgent().then((agent) => {
      setView(agent ? { kind: 'home', agent } : { kind: 'welcome' });
    });
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

  // view.kind === 'home'
  return (
    <Home
      agent={view.agent}
      onEdit={() => setView({ kind: 'edit', agent: view.agent })}
      onConnect={() => {
        // Phase 5 — Manual Pairing.
        // For now, the Connect flow is a no-op stub.
        alert('Connect flow lands in Phase 5 (Manual Pairing).');
      }}
    />
  );
}
