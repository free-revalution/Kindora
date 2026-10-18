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
 * owns the FSM (idle → hosting/joining → tcp-connected → connected → closed).
 * The transport owns the network I/O. We bridge between them via the
 * public PairingSession API:
 *
 *   host:
 *     1. session.startHost(transport)  — state: 'hosting', session
 *        generates its own code (single source of truth for the UI).
 *     2. transport.startHost(sessionCode)  — bind TCP+UDP, ready to
 *        answer UDP discovery filtered by sessionCode.
 *     3. Poll transport.isConnected() — when true, call
 *        session.notifyTransportConnected() so FSM moves to
 *        'tcp-connected' (the wire is up; the peer is not yet
 *        authenticated).
 *     4. The orchestrator drives the `hello` exchange. Once the
 *        peer's `hello` is received and validated, the orchestrator
 *        calls session.notifyHelloReceived(peerAgentId) so the FSM
 *        moves to 'connected'.
 *
 *   joiner:
 *     1. transport.discover(code)   — UDP broadcast filtered by code.
 *     2. transport.startJoin(peer)  — TCP dial.
 *     3. session.startJoin(transport, code) — state: 'joining' then
 *        'tcp-connected' (the session's `transport.connect()` is a
 *        no-op for LanTransport in 'join' mode).
 *     4. The orchestrator drives the `hello` exchange, transitioning
 *        the session to 'connected' once both sides have validated
 *        each other's `hello` envelope.
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
 *  1. Generate the 6-character pairing code (single source of truth
 *     that the session and the Rust transport share).
 *  2. Bind the LanTransport with that code via `transport.startHost(code)`.
 *     The Rust side now answers UDP discovery filtered by this code
 *     and listens for a TCP join. If this step throws, the session is
 *     NOT attached and stays in 'idle' — no half-state to clean up.
 *  3. Drive the session to 'hosting' via `session.startHost(transport,
 *     { seed: code })`. The session uses the same code we already
 *     handed to the transport, and its internal `transport.connect
 *     ({hint: code})` is now a no-op (transport.mode is 'host').
 *  4. Poll `transport.isConnected()`. When true, call
 *     `session.notifyPeerConnected()` so the FSM moves to
 *     'tcp-connected' (the wire is up; the peer is not yet
 *     authenticated).
 *  5. The orchestrator can now exchange hello / profile / match
 *     envelopes — see `MatchOrchestrator.start(session)`.
 *
 * Throws if the Tauri runtime is unavailable or if
 * `transport.startHost` fails. On any throw before step 3, nothing
 * has been wired up; the caller can safely retry.
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

  // Step 1: mint the code up-front. The session and the Rust
  // transport share this single value; we never run two RNGs.
  const code = generatePairingCode();

  // Step 2: bind the transport FIRST. If this throws (port in use,
  // Rust runtime failed, etc.) we have not touched the session, so
  // the FSM stays in 'idle'. The error propagates to the caller.
  await transport.startHost(code);

  // Step 3: drive the session. By construction the transport is in
  // 'host' mode, so the implicit `transport.connect({hint: code})`
  // inside `PairingSession.startHost` is a no-op — it just records
  // the self-info on the transport side. This is the Phase 16.3 fix
  // for the call-order bug: previously, this call happened BEFORE
  // `transport.startHost`, which left the transport in 'idle' mode
  // and caused a fire-and-forget joiner-style UDP discover (and in
  // the worst case, a self-dial into 'join' mode, leaving the
  // session in 'hosting' over a transport stuck in 'join').
  session.startHost(transport, { seed: code });
  if (session.current().state !== 'hosting' || session.current().code !== code) {
    // Defensive: should never happen because `seed` is validated,
    // but if a future refactor breaks one half of the contract, we
    // want to know loudly rather than over a confused session.
    await transport.disconnect().catch(() => undefined);
    throw new Error(
      'startLanHost: session.startHost did not produce the expected (hosting, code) state.',
    );
  }

  // Step 4: poll for the peer connecting. When transport.isConnected()
  // flips true, transition the session to 'tcp-connected' so the
  // orchestrator can drive the `hello` exchange and lift it to
  // 'connected'.
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
      // notifyPeerConnected is now an alias for notifyTransportConnected —
      // it transitions hosting → tcp-connected (NOT 'connected'). The
      // peer agent id is locked in later, by the orchestrator, when it
      // calls session.notifyHelloReceived(peerAgentId) after the
      // peer's `hello` envelope has been received and validated.
      session.notifyPeerConnected();
    }
  }, 200);

  // Idempotency guard for the disconnect path. See `disconnect` below.
  let disconnected = false;

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
      // Idempotent: a second caller (e.g. unmount cleanup racing
      // with a user-triggered disconnect) must not double-tear-down.
      // The transport and session disconnect are already no-ops
      // after the first call, but the `clearInterval` would warn in
      // strict mode and the duplicate `await transport.disconnect()`
      // is wasted IPC. Guard with the closed flag.
      if (disconnected) return;
      disconnected = true;
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
 *  3. session.startJoin(transport, code) — FSM: idle → joining →
 *     tcp-connected (the session's `transport.connect()` is a no-op
 *     for LanTransport in 'join' mode).
 *  4. The orchestrator drives the `hello` exchange and lifts the
 *     session to 'connected' once both sides have validated each
 *     other's `hello` envelope.
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
  // PairingSession.startJoin transitions: idle → joining →
  // tcp-connected. It calls transport.connect({hint: code}) which is
  // a no-op for LanTransport in 'join' mode (already connected via
  // startJoin). The orchestrator then drives the `hello` exchange and
  // calls session.notifyHelloReceived(peerAgentId) to move the FSM
  // to 'connected'.
  await session.startJoin(transport, code);
  // Idempotency guard for the disconnect path. See `disconnect` below.
  let disconnected = false;
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
      // Idempotent: see the matching comment in `startLanHost`. The
      // joiner side has no `setInterval` to clean up, but two
      // concurrent callers (e.g. the JoinPanel unmount cleanup and
      // a user-initiated cancel that arrives late) would each fire
      // `lan_join_disconnect` IPC; the second is a cheap no-op but
      // the guard keeps the call strictly one-shot.
      if (disconnected) return;
      disconnected = true;
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
  // The orchestrator accepts both 'tcp-connected' (it will drive the
  // `hello` exchange itself) and 'connected' (the `hello` exchange
  // was already validated by a previous step).
  const state = handle.session.current().state;
  if (state !== 'connected' && state !== 'tcp-connected') {
    throw new Error(
      `runLanMatch: session is not connected (state=${state}). Wait for the peer to join first.`,
    );
  }
  return handle.getOrchestrator().start(handle.session);
}

/** Re-export the code generator for callers that want to format the code in a UI. */
export { generatePairingCode };
