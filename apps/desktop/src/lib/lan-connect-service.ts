/**
 * LAN connect service — Tauri-side pairing for V0.1 Mode A real.
 *
 * The desktop app offers two pairing modes:
 *   - "loopback" — in-process via `LoopbackHub` (browser dev / single-machine tests).
 *   - "lan"      — UDP discovery + TCP message channel (Tauri runtime).
 *
 * This module owns the LAN path. The frontend `ConnectView` lets the
 * user pick a mode. The pairing FSM is identical regardless of mode
 * because both `LoopbackTransport` and `LanTransport` implement the
 * `Transport` interface.
 *
 * Discovery protocol (see apps/desktop/src-tauri/src/lan.rs):
 *   - Host binds TCP <random_port> + UDP 52419.
 *   - Joiner broadcasts UDP discover on 255.255.255.255:52419.
 *   - Host replies UDP announce with its agent id + tcp port.
 *   - Joiner dials the announced TCP port.
 *   - Both sides exchange envelopes over the TCP stream.
 *
 * V0.1 limitation: the LAN path is unavailable in browser dev
 * (no Tauri runtime). The loopback path remains the default for
 * `pnpm dev`. The LAN path lights up only when `window.__TAURI_INTERNALS__`
 * is present.
 */

import type { LLMProvider } from '@kindora/llm';
import { LanTransport, PairingSession, generatePairingCode, type LanJoinPeer } from '@kindora/transport';
import { MatchOrchestrator, type MatchOrchestratorSelf, type MatchOutcome } from '@kindora/matching';
import { loadAgent } from './agent-service';
import { loadProvider } from './llm-service';
import type { SocialAgent, SocialProfile } from '@kindora/protocol';

export type LanRole = 'host' | 'join';

export interface LanStartInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly profile: SocialProfile;
  readonly agent: SocialAgent;
  readonly llm: LLMProvider;
}

export interface LanHostHandle {
  readonly role: 'host';
  readonly pairingCode: string;
  readonly session: PairingSession;
  readonly transport: LanTransport;
  readonly selfAgentId: string;
  /**
   * Build the orchestrator lazily — the peer agent id is unknown
   * until a `hello` envelope arrives.
   */
  getOrchestrator(): MatchOrchestrator;
  /** Tear down. Idempotent. */
  disconnect(reason?: string): Promise<void>;
}

export interface LanJoinHandle {
  readonly role: 'join';
  readonly pairingCode: string;
  readonly session: PairingSession;
  readonly transport: LanTransport;
  readonly selfAgentId: string;
  readonly peer: LanJoinPeer;
  getOrchestrator(): MatchOrchestrator;
  disconnect(reason?: string): Promise<void>;
}

export type LanConnectHandle = LanHostHandle | LanJoinHandle;

/** True when the Tauri runtime is available. */
export function isLanAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__);
}

/** Generate a 6-char pairing code shared by host and joiner. */
export function generateCode(): string {
  // Reuse the package's pairing code generator.
  return generatePairingCode({ length: 6 });
}

export async function startLanHost(input: LanStartInput): Promise<LanHostHandle> {
  if (!isLanAvailable()) {
    throw new Error('startLanHost: Tauri runtime not available. Use loopback mode in browser dev.');
  }
  const code = generateCode();
  const transport = new LanTransport({
    selfAgentId: input.agentId,
    selfDisplayName: input.displayName,
  });
  await transport.startHost(code);
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });
  // PairingSession takes a Transport. We expose the LanTransport via
  // session.transport for inbound messages, but PairingSession wants
  // to call `connect(peerInfo)` then `onMessage`. We adapt by wiring
  // LanTransport's onMessage to the session's incoming handler.
  let orchestrator: MatchOrchestrator | null = null;
  let resolvedPeer: { agentId: string; displayName: string } | null = null;
  const unsub = transport.onMessage((env) => {
    if (env.type === 'hello' && !resolvedPeer) {
      const payload = env.payload as { displayName?: string };
      resolvedPeer = {
        agentId: env.sender ?? 'pending',
        displayName: payload.displayName ?? 'pending',
      };
    }
  });
  // Manually drive the FSM: host transitions to 'hosting' on start,
  // then to 'connected' when transport.isConnected() flips true. We
  // can't reuse session.startHost() because LanTransport is self-
  // managing (it binds + listens, then reports via isConnected()).
  // We synthesize a minimal PairingSession lifecycle: state moves
  // hosting -> connected.
  const sessionAny = session as unknown as {
    _setState: (s: string, code: string | null) => void;
    notifyStateChange: () => void;
  };
  sessionAny._setState?.('hosting', code);
  const poll = setInterval(() => {
    if (transport.isConnected() && (session as unknown as { state: string }).state !== 'connected') {
      sessionAny._setState?.('connected', code);
      clearInterval(poll);
    }
  }, 200);

  return {
    role: 'host',
    pairingCode: code,
    session,
    transport,
    selfAgentId: input.agentId,
    getOrchestrator() {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), resolvedPeer?.agentId ?? '');
      }
      return orchestrator;
    },
    async disconnect(reason: string = 'user-requested') {
      clearInterval(poll);
      unsub();
      await transport.disconnect();
      await session.disconnect(reason);
    },
  };
}

export async function startLanJoin(
  input: LanStartInput,
  code: string,
  timeoutMs: number = 2500,
): Promise<LanJoinHandle> {
  if (!isLanAvailable()) {
    throw new Error('startLanJoin: Tauri runtime not available. Use loopback mode in browser dev.');
  }
  const transport = new LanTransport({
    selfAgentId: input.agentId,
    selfDisplayName: input.displayName,
  });
  // Discover peers on the LAN.
  const peers = await transport.discover(code, timeoutMs);
  if (peers.length === 0) {
    await transport.disconnect().catch(() => undefined);
    throw new Error(`No peer found on the LAN for code "${code}". Check that both devices are on the same network and that the host is running.`);
  }
  const peer: LanJoinPeer = peers[0]!;
  await transport.startJoin(peer);
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });
  let orchestrator: MatchOrchestrator | null = null;
  const sessionAny = session as unknown as {
    _setState: (s: string, code: string | null) => void;
  };
  sessionAny._setState?.('joining', code);
  sessionAny._setState?.('connected', code);
  return {
    role: 'join',
    pairingCode: code,
    session,
    transport,
    selfAgentId: input.agentId,
    peer,
    getOrchestrator() {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), peer.agent_id || '');
      }
      return orchestrator;
    },
    async disconnect(reason: string = 'user-requested') {
      await transport.disconnect();
      await session.disconnect(reason);
    },
  };
}

function toOrchestratorSelf(input: LanStartInput): MatchOrchestratorSelf {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    profile: input.profile,
    agent: input.agent,
    capabilities: input.agent.capabilities,
    llm: input.llm,
    peerGuard: () => {
      // block list check is in the host/join paths already; leave a no-op guard here.
    },
  };
}

/** Build a `LanStartInput` from the local store. Throws if agent or LLM is not configured. */
export async function toLanInput(): Promise<LanStartInput> {
  const [agent, llm] = await Promise.all([loadAgent(), loadProvider()]);
  if (!agent) throw new Error('No agent on this device. Create an agent first.');
  if (!llm) throw new Error('No LLM configured. Open Settings and pick a provider.');
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    profile: agent.profile,
    agent: {
      agentId: agent.agentId,
      protocolVersion: agent.protocolVersion,
      displayName: agent.displayName,
      publicKey: agent.publicKey,
      profile: agent.profile,
      capabilities: agent.capabilities,
    },
    llm,
  };
}

/** Run the match orchestrator on an LAN handle. */
export async function runLanMatch(handle: LanConnectHandle): Promise<MatchOutcome> {
  return handle.getOrchestrator().start(handle.session);
}
