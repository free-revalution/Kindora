import { AGENT_RUNTIME_VERSION, createAgentConfig } from '@kindora/agent';
import { PROTOCOL_NAME, PROTOCOL_VERSION } from '@kindora/protocol';

/**
 * Welcome screen — V0.1 Phase 0 placeholder.
 *
 * Real Create-Agent flow lands in Phase 1 (see 开发手册.md § 6.2).
 */
export default function App() {
  const agentCfg = createAgentConfig();

  return (
    <main className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">Kindora</h1>
      <p className="text-kindora-700 dark:text-kindora-200 mt-6 text-lg">
        Your AI finds the connection.
        <br />
        You make the friendship.
      </p>

      <section className="kindora-card mt-12 w-full text-left">
        <h2 className="text-base font-semibold">Phase 0 — Bootstrap</h2>
        <ul className="text-kindora-700 dark:text-kindora-200 mt-4 space-y-2 text-sm">
          <li>
            Protocol: <code className="font-mono">{PROTOCOL_NAME}</code> v
            <code className="font-mono">{PROTOCOL_VERSION}</code>
          </li>
          <li>
            Agent runtime: <code className="font-mono">v{AGENT_RUNTIME_VERSION}</code>
          </li>
          <li>
            Max agent-to-agent messages:{' '}
            <code className="font-mono">{agentCfg.maxAgentMessages}</code>
          </li>
        </ul>
      </section>

      <button type="button" className="kindora-button mt-10" disabled>
        Create My Agent (Phase 1)
      </button>
    </main>
  );
}
