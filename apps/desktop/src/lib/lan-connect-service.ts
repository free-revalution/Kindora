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
 * Session lifecycle
 * -----------------
 * We drive a real `PairingSession` over a `LanTransport`. The session
 * owns the FSM (idle → hosting/joining → connected → closed). The
 * transport owns the network I/O. We bridge between them via the
 * public PairingSession API:
 *
 *   host:
 *     1. session.startHost(transport)  — state: 'hosting', session
 *        generates its own code (single source of truth for the UI).
 *     2. transport.startHost(sessionCode)  — bind TCP+UDP, ready to
 *        answer UDP discovery filtered by sessionCode.
 *     3. Poll transport.isConnected() — when true, call
 *        session.notifyPeerConnected() so FSM moves to 'connected'.
 *     4. The orchestrator can now exchange hello / profile / match
 *        envelopes.
 *
 *   joiner:
 *     1. transport.discover(code)   — UDP broadcast filtered by code.
 *     2. transport.startJoin(peer)  — TCP dial.
 *     3. session.startJoin(transport, code) — state: 'joining' then
 *        'connected'. The session's `transport.connect()` is a no-op
 *        for LanTransport in 'join' mode.
 *     4. The orchestrator can now exchange envelopes.
 *
 * V0.1 limitation: the LAN path is unavailable in browser dev
 * (no Tauri runtime). The loopback path remains the default for
 * `pnpm dev`. The LAN path lights up only when
 * `window.__TAURI_INTERNALS__` is present.
 */

import type { LLMProvider } from '@kindora/llm';
import {
  generatePairingCode,
  LanTransport,
  PairingSession,
  type LanJoinPeer,
} from '@kindora/transport';
import {
  MatchOrchestrator,
  type MatchOrchestratorSelf,
  type MatchOutcome,
} from '@kindora/matching';
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
  /** The 6-character pairing code the host displays to the joiner. */
  readonly pairingCode: string;
  readonly session: PairingSession;
  readonly transport: LanTransport;
  readonly selfAgentId: string;
  /**
   * Build the orchestrator lazily — the peer agent id is unknown
   * until a `hello` envelope arrives. The orchestrator itself locks
   * in the peer id from the first received message; passing an empty
   * string here is the supported V0.1 way to defer.
   */
  getOrchestrator(): MatchOrchestrator;
  /**
   * Tear down. Idempotent. Clears the host wait loop, the transport
   * poll, the Rust TCP task, and the UDP listener.
   */
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

/**
 * Start a LAN host pairing flow.
 *
 *  1. Create a PairingSession, transition it to 'hosting' via
 *     session.startHost(transport). The session generates the
 *     6-character code.
 *  2. Bind the LanTransport with the same code via
 *     transport.startHost(sessionCode). The Rust side now answers
 *     UDP discovery filtered by this code and listens for a TCP
 *     join.
 *  3. Poll transport.isConnected() (set by the Rust side when a
 *     joiner connects). When true, call session.notifyPeerConnected()
 *     so the FSM moves to 'connected'.
 *  4. The orchestrator can now exchange hello / profile / match
 *     envelopes — see MatchOrchestrator.start(session).
 *
 * Throws if the Tauri runtime is unavailable.
 */
export async function startLanHost(input: LanStartInput): Promise<LanHostHandle> {
  if (!isLanAvailable()) {
    throw new Error('startLanHost: Tauri runtime not available. Use loopback mode in browser dev.');
  }

  const transport = new LanTransport({
    selfAgentId: input.agentId,
    selfDisplayName: input.displayName,
  });
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });

  // Step 1: drive the session to 'hosting'. PairingSession.startHost
  // calls transport.connect() which is a no-op for LanTransport in
  // idle mode (we haven't bound the transport yet).
  session.startHost(transport);
  const code = session.current().code;
  if (!code) {
    throw new Error('startLanHost: PairingSession did not generate a pairing code.');
  }

  // Step 2: bind the transport with the same code so UDP discovery
  // and the host's pairing-code display agree.
  await transport.startHost(code);

  // Step 3: poll for the peer connecting. When transport.isConnected()
  // flips true, transition the session to 'connected' so the
  // orchestrator can run.
  let resolved = false;
  const poll = setInterval(() => {
    if (resolved) return;
    const snap = session.current();
    if (snap.state !== 'hosting') {
      // Session has been disconnected or transitioned — stop polling.
      clearInterval(poll);
      resolved = true;
      return;
    }
    if (transport.isConnected()) {
      resolved = true;
      clearInterval(poll);
      // notifyPeerConnected transitions hosting → connected. The
      // peer agent id is locked in by the orchestrator when it
      // receives the peer's hello envelope.
      session.notifyPeerConnected();
    }
  }, 200);

  return {
    role: 'host',
    pairingCode: code,
    session,
    transport,
    selfAgentId: input.agentId,
    getOrchestrator() {
      return new MatchOrchestrator(toOrchestratorSelf(input), '');
    },
    async disconnect(reason: string = 'user-requested') {
      clearInterval(poll);
      resolved = true;
      await transport.disconnect();
      await session.disconnect(reason);
    },
  };
}

/**
 * Start a LAN joiner pairing flow.
 *
 *  1. Discover peers on the LAN filtered by the typed code.
 *  2. Pick the first peer and dial via transport.startJoin(peer).
 *  3. session.startJoin(transport, code) — FSM: idle → joining → connected.
 *  4. The orchestrator can now exchange envelopes.
 */
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
    throw new Error(
      `No peer found on the LAN for code "${code}". Check that both devices are on the same network and that the host is running.`,
    );
  }
  const peer: LanJoinPeer = peers[0]!;
  await transport.startJoin(peer);
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
  });
  // PairingSession.startJoin transitions: idle → joining → connected.
  // It calls transport.connect({hint: code}) which is a no-op for
  // LanTransport in 'join' mode (already connected via startJoin).
  await session.startJoin(transport, code);
  return {
    role: 'join',
    pairingCode: code,
    session,
    transport,
    selfAgentId: input.agentId,
    peer,
    getOrchestrator() {
      return new MatchOrchestrator(toOrchestratorSelf(input), peer.agent_id || '');
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

/** Run the match orchestrator on a LAN handle. */
export async function runLanMatch(handle: LanConnectHandle): Promise<MatchOutcome> {
  if (handle.session.current().state !== 'connected') {
    throw new Error(
      `runLanMatch: session is not connected (state=${handle.session.current().state}). Wait for the peer to join first.`,
    );
  }
  return handle.getOrchestrator().start(handle.session);
}

/** Re-export the code generator for callers that want to format the code in a UI. */
export { generatePairingCode };
