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
  ConnectionStateMachine,
  LanTransport,
  PairingSession,
  derivePairingFingerprint,
  normalisePairingCode,
  PAIRING_FINGERPRINT_LENGTH,
  type ConnectionState,
  type ConnectionStateHandler,
  type LanJoinPeer,
} from '@kindora/transport';
import {
  MatchOrchestrator,
  PeerBlockedError,
  type LocalConsent,
  type MatchOrchestratorSelf,
  type MatchOutcome,
  type PeerIntroduction,
} from '@kindora/matching';
import { createEnvelopeSigner } from '@kindora/agent';
import { loadAgent } from './agent-service';
import { loadProvider } from './llm-service';
import { getBlockedAgentsStore } from './connect-service';
import {
  base64ToBytes,
  type EnvelopeSigner,
  type SocialAgent,
  type SocialProfile,
} from '@kindora/protocol';

export type LanRole = 'host' | 'join';

export interface LanStartInput {
  readonly agentId: string;
  readonly displayName: string;
  readonly profile: SocialProfile;
  readonly agent: SocialAgent;
  readonly llm: LLMProvider;
  /**
   * Phase A / A2 — the signer for outbound envelopes. `null` when the
   * runtime has no usable WebCrypto.
   */
  readonly signer: EnvelopeSigner | null;
  /**
   * Phase A / A3 — this agent's pairing fingerprint (six characters
   * derived from its own public key).
   *
   * This is an **identity fingerprint**, not a password and not a
   * temporary key. It identifies the host; it does not by itself
   * authorise anything.
   */
  readonly fingerprint: string;
}

/**
 * Phase C / C3 — the internals a reconnect needs.
 *
 * Exposed on the handle so `reconnect()` can rebuild the session and
 * the transport without the caller having to hand the service the
 * agent profile, the LLM provider, and the identity fingerprint all
 * over again.
 *
 * The fingerprint in particular **must not** change under the peer's
 * feet: the peer checks the fingerprint it was given against the key
 * that answers, so a reconnect has to present the same identity.
 */
export interface LanHandleInternals {
  readonly input: LanStartInput;
  readonly machine: ConnectionStateMachine;
}

/**
 * Phase C / C3 — what every LAN handle can do, whatever its role.
 */
export interface LanConnectionHandle {
  /** The 6-character pairing code (the host's identity fingerprint). */
  readonly pairingCode: string;
  /**
   * The live pairing session.
   *
   * Phase C / C3: this is a **getter** on the concrete handle — after
   * a `reconnect()` it returns the *new* session, so a caller that
   * kept the handle reference does not have to swap it out.
   */
  readonly session: PairingSession;
  /** The live transport. Same getter contract as `session`. */
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
   * Phase C / C3 § 1 + § 8 — the connection lifecycle, as the UI has
   * to show it: 连接中 / 已连接 / 断开 / 重连中 / 失败.
   */
  connectionState(): ConnectionState;
  /**
   * Phase C / C3 § 1 + § 8 — subscribe to connection-state changes.
   * Returns an unsubscribe function.
   */
  onConnectionStateChange(handler: ConnectionStateHandler): () => void;
  /**
   * Tear down. Idempotent. Clears the host wait loop, the transport
   * poll, the Rust TCP task, and the UDP listener.
   */
  disconnect(reason?: string): Promise<void>;
  /** @internal — used by `reconnect()`. */
  readonly internals: LanHandleInternals;
}

export interface LanHostHandle extends LanConnectionHandle {
  readonly role: 'host';
  /**
   * Phase C / C3 § 3 + § 5 — pair again after the link dropped.
   *
   * The current transport and session are torn down and **new** ones
   * are built from scratch, so the reconnect redoes the whole
   * handshake: a fresh ephemeral key pair, a fresh `hello` exchange,
   * a fresh session key. Nothing is carried over from the dead link.
   *
   * The handle stays valid — `handle.session` and `handle.transport`
   * return the new objects once the reconnect resolves.
   */
  reconnect(): Promise<LanHostHandle>;
}

export interface LanJoinHandle extends LanConnectionHandle {
  readonly role: 'join';
  readonly peer: LanJoinPeer;
  /**
   * Phase C / C3 § 3 + § 5 — pair again after the link dropped.
   * Same contract as `LanHostHandle.reconnect`.
   */
  reconnect(): Promise<LanJoinHandle>;
}

export type LanConnectHandle = LanHostHandle | LanJoinHandle;

/** True when the Tauri runtime is available. */
export function isLanAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__);
}

/**
 * The Rust side keeps exactly one host slot and binds a fixed UDP
 * discovery port (52419), so two LAN hosts cannot coexist: the second
 * responder loses the bind (EADDRINUSE) and the start is rejected with
 * "already running in mode host".
 *
 * Two starts really do arrive back to back in practice — React
 * StrictMode double-invokes effects in development, and the Connect
 * screen re-runs its host effect whenever the transport changes. The
 * cleanup chain inside `LanTransport` cannot help, because every start
 * builds a *new* transport instance and each instance has its own
 * chain. So the serialisation lives here, one level up, where the
 * resource actually lives.
 */
let activeLanHost: LanHostHandle | null = null;
let lanHostChain: Promise<unknown> = Promise.resolve();

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
 *
 * Calls are serialised — see `lanHostChain` below.
 */
export async function startLanHost(input: LanStartInput): Promise<LanHostHandle> {
  const run = async (): Promise<LanHostHandle> => {
    // Tear down whatever was running before we bind. This happens
    // *inside* the chain on purpose: the previous host may still be
    // starting when this call arrives, so reading `activeLanHost` at
    // call time would miss it.
    //
    // `previous.disconnect()` is awaitable, so we do not bind until
    // the Rust side has actually released the host slot and the fixed
    // discovery port.
    const previous = activeLanHost;
    if (previous) {
      activeLanHost = null;
      await previous.disconnect('superseded');
    }
    // Phase C / C3 § 1: every pairing flow gets its own connection
    // lifecycle. The machine lives on the handle, so a reconnect keeps
    // the same one and the UI's subscription survives.
    const handle = await startLanHostInner(input, new ConnectionStateMachine());
    activeLanHost = handle;
    return handle;
  };
  const result = lanHostChain.then(run, run);
  // The chain must never reject: one failed start would otherwise
  // poison every later one.
  lanHostChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Phase C / C3 — the parts of a host connection that a reconnect has
 * to rebuild from scratch.
 *
 * The point of the split is C3 § 5: a reconnect must redo the
 * identity check and the secure handshake, so it must NOT be a
 * "reuse the old session" operation. Everything per-connection lives
 * here and is thrown away and rebuilt.
 */
interface HostRuntime {
  readonly session: PairingSession;
  readonly transport: LanTransport;
  /** Stop the "is the peer there yet?" poll. */
  stop(): void;
  /** The one-shot teardown promise, so a double disconnect is a no-op. */
  disposePromise: Promise<void> | null;
}

async function startLanHostInner(
  input: LanStartInput,
  machine: ConnectionStateMachine,
): Promise<LanHostHandle> {
  machine.set('connecting');
  if (!isLanAvailable()) {
    machine.set('failed');
    throw new Error('startLanHost: Tauri runtime not available. Use loopback mode in browser dev.');
  }

  // Step 1: mint the code up-front. The session and the Rust
  // transport share this single value; we never run two RNGs.
  //
  // Phase A / A3: the code is this agent's **identity fingerprint**,
  // derived from its own long-term public key — not a random secret.
  // It is what the host shows and what the joiner types; the joiner
  // then checks that the peer really hashes to it (see
  // `expectedPeerFingerprint` in `startLanJoin`).
  const code = normalisePairingCode(input.fingerprint);
  if (!code || code.length !== PAIRING_FINGERPRINT_LENGTH) {
    machine.set('failed');
    throw new Error(
      'startLanHost: the local identity fingerprint is malformed. Recreate the agent and try again.',
    );
  }

  /**
   * Build one host connection: a transport bound to the LAN, a
   * session driving it, and the poll that watches for the peer.
   *
   * A reconnect calls this again, which is exactly what C3 § 5 asks
   * for — the whole handshake is redone from scratch.
   */
  const build = async (): Promise<HostRuntime> => {
    const transport = new LanTransport({
      selfAgentId: input.agentId,
      selfDisplayName: input.displayName,
    });
    const session = new PairingSession({
      agentId: input.agentId,
      displayName: input.displayName,
      signer: input.signer,
    });

    // Step 2: bind the transport FIRST. If this throws (port in use,
    // Rust runtime failed, etc.) we have not touched the session, so
    // the FSM stays in 'idle'. The error propagates to the caller.
    try {
      await transport.startHost(code);
    } catch (e) {
      await transport.disconnect().catch(() => undefined);
      throw e;
    }

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

    return {
      session,
      transport,
      stop() {
        clearInterval(poll);
        resolved = true;
      },
      disposePromise: null,
    };
  };

  /**
   * Phase C / C3 § 2 — tear one connection down, exactly once.
   *
   * The promise is stored on the runtime, so two concurrent callers
   * (the unmount cleanup and a user-initiated cancel) share one
   * teardown instead of racing two `lan_host_stop` calls.
   */
  const disposeRuntime = (rt: HostRuntime, reason: string): Promise<void> => {
    if (!rt.disposePromise) {
      rt.disposePromise = (async () => {
        rt.stop();
        await rt.transport.disconnect();
        await rt.session.disconnect(reason);
      })();
    }
    return rt.disposePromise;
  };

  let runtime!: HostRuntime;
  try {
    runtime = await build();
  } catch (e) {
    machine.set('failed');
    throw e;
  }

  // Phase C / C3 § 1 — map the pairing FSM onto the connection
  // lifecycle the UI shows.
  //
  //   - the session reached `connected` → the connection is
  //     `connected` (the handshake, and therefore the identity check,
  //     is done).
  //   - the session closed after that → `disconnected` (recoverable:
  //     the user can ask for a reconnect).
  //   - the session closed before that → `failed`.
  //
  // The generation counter lets a reconnect mark the previous
  // session's mapping stale, so the teardown's "closed" transition
  // does not push a "disconnected" over the "reconnecting" the
  // reconnect has already claimed.
  let generation = 0;
  const watch = (s: PairingSession): void => {
    const mine = generation;
    s.onStateChange((snap) => {
      if (generation !== mine) return;
      if (snap.state === 'connected') {
        machine.set('connected');
      } else if (snap.state === 'closed') {
        machine.set(machine.current() === 'connected' ? 'disconnected' : 'failed');
      }
    });
  };
  watch(runtime.session);

  // The live pair. A reconnect swaps them out; the handle's getters
  // read whichever is current.
  let liveSession = runtime.session;
  let liveTransport = runtime.transport;

  const handle: LanHostHandle = {
    role: 'host',
    pairingCode: code,
    get session(): PairingSession {
      return liveSession;
    },
    get transport(): LanTransport {
      return liveTransport;
    },
    selfAgentId: input.agentId,
    getOrchestrator() {
      return new MatchOrchestrator(toOrchestratorSelf(input), '');
    },
    connectionState() {
      return machine.current();
    },
    onConnectionStateChange(handler) {
      return machine.subscribe(handler);
    },
    internals: { input, machine },
    async disconnect(reason: string = 'user-requested') {
      try {
        // Idempotent, but *awaitable*: a second caller waits for the
        // same teardown instead of returning immediately.
        //
        // This matters because the Rust side owns a single host slot and
        // a fixed UDP discovery port. A caller that returns early lets
        // the next `startLanHost` bind before the Rust `host_stop` has
        // landed, which surfaces as "already running in mode host" or as
        // a discovery responder that lost the bind with EADDRINUSE.
        //
        // Phase C / C3: the generation bump detaches the session's
        // state mapping, so an explicit teardown does not masquerade
        // as a peer drop ("disconnected").
        generation += 1;
        await disposeRuntime(runtime, reason);
        machine.set('idle');
      } finally {
        // This handle is no longer the live host, so the service-level
        // singleton does not have to tear it down again.
        if (activeLanHost === handle) activeLanHost = null;
      }
    },
    async reconnect(): Promise<LanHostHandle> {
      // Phase C / C3 § 3 + § 5 — tear the dead link down and pair
      // again from scratch. The new session starts in `idle`, so the
      // identity check and the secure handshake are redone — nothing
      // is carried over from the link that died.
      generation += 1;
      machine.set('reconnecting');
      await disposeRuntime(runtime, 'reconnect').catch(() => undefined);
      let next: HostRuntime;
      try {
        next = await build();
      } catch (e) {
        machine.set('failed');
        throw e;
      }
      runtime = next;
      liveSession = next.session;
      liveTransport = next.transport;
      watch(next.session);
      machine.set('connecting');
      return handle;
    },
  };
  return handle;
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
  return startLanJoinInner(input, code, timeoutMs, new ConnectionStateMachine());
}

/**
 * Phase C / C3 — the parts of a joiner connection that a reconnect
 * has to rebuild. Same split as the host: a reconnect is a fresh
 * transport + a fresh session, never a reused one.
 */
interface JoinRuntime {
  readonly session: PairingSession;
  readonly transport: LanTransport;
  readonly peer: LanJoinPeer;
  /** The one-shot teardown promise, so a double disconnect is a no-op. */
  disposePromise: Promise<void> | null;
}

async function startLanJoinInner(
  input: LanStartInput,
  code: string,
  timeoutMs: number,
  machine: ConnectionStateMachine,
): Promise<LanJoinHandle> {
  machine.set('connecting');
  if (!isLanAvailable()) {
    machine.set('failed');
    throw new Error('startLanJoin: Tauri runtime not available. Use loopback mode in browser dev.');
  }
  // Phase A / A3: the typed code is the host's identity fingerprint.
  // Normalise it *before* it reaches the wire: the host registered the
  // fingerprint without the cosmetic dash, and the Rust side compares
  // the two strings byte for byte.
  const normalised = normalisePairingCode(code);
  if (!normalised || normalised.length !== PAIRING_FINGERPRINT_LENGTH) {
    machine.set('failed');
    throw new Error(
      `That is not a valid identity fingerprint. It is ${PAIRING_FINGERPRINT_LENGTH} characters from the alphabet 0123456789ABCDEFGHJKMNPQRSTVWXYZ.`,
    );
  }

  /**
   * Build one joiner connection: discover the host, dial it, and
   * drive a session over it.
   */
  const build = async (): Promise<JoinRuntime> => {
    const transport = new LanTransport({
      selfAgentId: input.agentId,
      selfDisplayName: input.displayName,
    });
    // Discover peers on the LAN.
    const peers = await transport.discover(normalised, timeoutMs);
    if (peers.length === 0) {
      await transport.disconnect().catch(() => undefined);
      throw new Error(
        `No peer found on the LAN for fingerprint "${normalised}". Check that both devices are on the same network and that the host is running.`,
      );
    }
    const peer: LanJoinPeer = peers[0]!;
    await transport.startJoin(peer);
    const session = new PairingSession({
      agentId: input.agentId,
      displayName: input.displayName,
      signer: input.signer,
      // The out-of-band identity check: the peer that answers must
      // present the public key this fingerprint was derived from.
      expectedPeerFingerprint: normalised,
    });
    // PairingSession.startJoin transitions: idle → joining →
    // tcp-connected. It calls transport.connect({hint: code}) which is
    // a no-op for LanTransport in 'join' mode (already connected via
    // startJoin). The orchestrator then drives the `hello` exchange and
    // calls session.notifyHelloReceived(peerAgentId) to move the FSM
    // to 'connected'.
    await session.startJoin(transport, normalised);
    return { session, transport, peer, disposePromise: null };
  };

  /** Phase C / C3 § 2 — tear one connection down, exactly once. */
  const disposeRuntime = (rt: JoinRuntime, reason: string): Promise<void> => {
    if (!rt.disposePromise) {
      rt.disposePromise = (async () => {
        await rt.transport.disconnect();
        await rt.session.disconnect(reason);
      })();
    }
    return rt.disposePromise;
  };

  let runtime!: JoinRuntime;
  try {
    runtime = await build();
  } catch (e) {
    machine.set('failed');
    throw e;
  }

  // Phase C / C3 § 1 — the session→lifecycle mapping. See the host
  // side for the full explanation of the generation counter.
  let generation = 0;
  const watch = (s: PairingSession): void => {
    const mine = generation;
    s.onStateChange((snap) => {
      if (generation !== mine) return;
      if (snap.state === 'connected') {
        machine.set('connected');
      } else if (snap.state === 'closed') {
        machine.set(machine.current() === 'connected' ? 'disconnected' : 'failed');
      }
    });
  };
  watch(runtime.session);

  let liveSession = runtime.session;
  let liveTransport = runtime.transport;

  const handle: LanJoinHandle = {
    role: 'join',
    pairingCode: normalised,
    get session(): PairingSession {
      return liveSession;
    },
    get transport(): LanTransport {
      return liveTransport;
    },
    selfAgentId: input.agentId,
    get peer(): LanJoinPeer {
      return runtime.peer;
    },
    getOrchestrator() {
      return new MatchOrchestrator(toOrchestratorSelf(input), runtime.peer.agent_id || '');
    },
    connectionState() {
      return machine.current();
    },
    onConnectionStateChange(handler) {
      return machine.subscribe(handler);
    },
    internals: { input, machine },
    async disconnect(reason: string = 'user-requested') {
      // Idempotent: see the matching comment in `startLanHost`. The
      // joiner side has no `setInterval` to clean up, but two
      // concurrent callers (e.g. the JoinPanel unmount cleanup and
      // a user-initiated cancel that arrives late) would each fire
      // `lan_join_disconnect` IPC; the second is a cheap no-op but
      // the guard keeps the call strictly one-shot.
      generation += 1;
      await disposeRuntime(runtime, reason);
      machine.set('idle');
    },
    async reconnect(): Promise<LanJoinHandle> {
      // Phase C / C3 § 3 + § 5 — a fresh discovery, a fresh dial, and
      // a fresh session, so the identity check and the secure
      // handshake are redone from scratch.
      generation += 1;
      machine.set('reconnecting');
      await disposeRuntime(runtime, 'reconnect').catch(() => undefined);
      let next: JoinRuntime;
      try {
        next = await build();
      } catch (e) {
        machine.set('failed');
        throw e;
      }
      runtime = next;
      liveSession = next.session;
      liveTransport = next.transport;
      watch(next.session);
      machine.set('connecting');
      return handle;
    },
  };
  return handle;
}

function toOrchestratorSelf(input: LanStartInput): MatchOrchestratorSelf {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    profile: input.profile,
    agent: input.agent,
    capabilities: input.agent.capabilities,
    llm: input.llm,
    peerGuard: async (peerAgentId: string) => {
      // Phase B: the block-list check runs in phase 1, **before** the
      // public card is sent. The LAN path used to have no guard at
      // all — a blocked peer could complete a LAN pairing and receive
      // the local card.
      if (!peerAgentId) return;
      if (await getBlockedAgentsStore().has(peerAgentId)) {
        throw new PeerBlockedError(peerAgentId);
      }
    },
    boundaries: async () => {
      // Phase B requirement 8 — read the boundaries in force right now
      // so a mid-session revocation takes effect on the next send.
      try {
        const agent = await loadAgent();
        if (agent) return agent.profile.boundaries;
      } catch (err: unknown) {
        console.error(
          'Kindora: could not re-read the privacy boundaries; using the ones captured when the session started.',
          err,
        );
      }
      return input.profile.boundaries;
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
    signer: await buildSigner(agent),
    fingerprint: await derivePairingFingerprint(agent.agentId, base64ToBytes(agent.publicKey)),
  };
}

/**
 * Phase A / A2 — build the envelope signer for the local agent.
 *
 * `loadAgent()` attaches the private key in memory (it lives in the OS
 * keychain in the shipped app). The signer imports it as a
 * **non-extractable** WebCrypto key.
 *
 * Returns `null` when the runtime has no usable WebCrypto: the
 * session then runs unsigned, and the capability flags say so.
 */
async function buildSigner(agent: {
  readonly agentId: string;
  readonly publicKey: string;
  readonly privateKey?: string;
}): Promise<EnvelopeSigner | null> {
  if (!agent.privateKey) return null;
  try {
    return await createEnvelopeSigner({
      agentId: agent.agentId,
      publicKey: agent.publicKey,
      privateKey: agent.privateKey,
    });
  } catch {
    // No usable WebCrypto (or a corrupt key). The capability flags
    // already report `supportsMessageSigning: false` in that case.
    return null;
  }
}

/**
 * Phase 1 — identify the peer over the LAN link: send the `hello` and
 * the **minimal public card**, refusing a blocked peer before any
 * profile data leaves the device.
 */
export async function runLanIdentify(handle: LanConnectHandle): Promise<PeerIntroduction> {
  // The orchestrator accepts both 'tcp-connected' (it will drive the
  // `hello` exchange itself) and 'connected' (the `hello` exchange
  // was already validated by a previous step).
  const state = handle.session.current().state;
  if (state !== 'connected' && state !== 'tcp-connected') {
    throw new Error(
      `runLanIdentify: session is not connected (state=${state}). Wait for the peer to join first.`,
    );
  }
  return handle.getOrchestrator().identify(handle.session);
}

/**
 * Phase 2 — exchange the **authorised** profile over the LAN link and
 * run the match analysis. Refuses to send anything without a mutual,
 * peer-specific consent.
 */
export async function runLanExchangeAndMatch(
  handle: LanConnectHandle,
  consent: LocalConsent,
): Promise<MatchOutcome> {
  const state = handle.session.current().state;
  if (state !== 'connected' && state !== 'tcp-connected') {
    throw new Error(`runLanExchangeAndMatch: session is not connected (state=${state}).`);
  }
  return handle.getOrchestrator().exchangeAndMatch(handle.session, consent);
}

/**
 * Re-export the code generator for callers that want to format the code
 * in a UI.
 *
 * Phase A / A3: the LAN pairing code is now the host's **identity
 * fingerprint**, not a random code — see `derivePairingFingerprint`.
 * This re-export stays for callers that still want a random code for
 * something else (e.g. a test fixture); nothing in the pairing flow
 * uses it any more.
 */
export { generatePairingCode } from '@kindora/transport';
