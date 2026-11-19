/**
 * WebRTC connect service — Mode B manual signalling (+ same-device lab).
 *
 * Host and joiner exchange opaque SDP blobs out of band, or — for
 * single-PC verification — use `BroadcastChannel` lab signalling so
 * two windows pair without copy/paste.
 *
 * Phase C / C3: owns a `ConnectionStateMachine`. Mode B / lab have no
 * automatic reconnect (a new SDP exchange is required).
 */

import {
  ManualSignallingAdapter,
  BroadcastSignallingAdapter,
  HttpSignallingAdapter,
  WebRtcTransport,
  PairingSession,
  ConnectionStateMachine,
  isWebRtcAvailable,
  isBroadcastSignallingAvailable,
  isHttpSignallingUrl,
  type ConnectionState,
  type ConnectionStateHandler,
  type WebRtcSignallingAdapter,
} from '@kindora/transport';
import { MatchOrchestrator, type MatchOrchestratorSelf } from '@kindora/matching';
import {
  assertPeerNotBlocked,
  type ConnectHandle,
  type StartInput,
} from './connect-service';
import { loadAgent } from './agent-service';
import { loadIceServers, loadSignallingUrl } from './webrtc-settings';

export type WebRtcSignallingMode = 'manual' | 'lab' | 'server';

export interface WebRtcConnectHandle extends ConnectHandle {
  readonly signallingMode: WebRtcSignallingMode;
  /** Present for manual Mode B — UI pastes blobs through this. */
  readonly signalling: ManualSignallingAdapter | null;
  readonly role: 'offer' | 'answer';
  takeOutboundBlob(): Promise<string>;
  applyInboundBlob(blob: string): void;
  connectionState(): ConnectionState;
  onConnectionStateChange(handler: ConnectionStateHandler): () => void;
}

function toOrchestratorSelf(input: StartInput): MatchOrchestratorSelf {
  return {
    agentId: input.agentId,
    displayName: input.displayName,
    profile: input.profile,
    agent: input.agent,
    capabilities: input.agent.capabilities,
    llm: input.llm,
    peerGuard: async (peerAgentId: string) => {
      await assertPeerNotBlocked(peerAgentId);
    },
    boundaries: async () => {
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

export function isWebRtcConnectAvailable(): boolean {
  return isWebRtcAvailable();
}

export function isWebRtcLabAvailable(): boolean {
  return isWebRtcAvailable() && isBroadcastSignallingAvailable();
}

/** Mode C — requires RTCPeerConnection + a configured HTTP signalling URL. */
export function isWebRtcServerSignallingAvailable(): boolean {
  const url = loadSignallingUrl();
  return isWebRtcAvailable() && url.length > 0 && isHttpSignallingUrl(url);
}

function wireSessionToMachine(
  session: PairingSession,
  transport: WebRtcTransport,
  machine: ConnectionStateMachine,
): () => void {
  const offSession = session.onStateChange((snap) => {
    if (snap.state === 'hosting' || snap.state === 'joining' || snap.state === 'tcp-connected') {
      machine.set('connecting');
    } else if (snap.state === 'connected') {
      machine.set('connected');
    } else if (snap.state === 'closed') {
      if (machine.current() === 'connected' || machine.current() === 'connecting') {
        const reason = snap.closeReason;
        if (reason === 'user-requested' || reason === 'cancelled') {
          machine.set('disconnected');
        } else if (machine.current() === 'connecting') {
          machine.set('failed');
        } else {
          machine.set('disconnected');
        }
      }
    }
  });
  const offClose = transport.onClose(() => {
    if (machine.current() === 'connected' || machine.current() === 'connecting') {
      machine.set('disconnected');
    }
  });
  return () => {
    offSession();
    offClose();
  };
}

function makeSignalling(
  mode: WebRtcSignallingMode,
  role: 'offer' | 'answer',
  roomId: string,
): {
  adapter: WebRtcSignallingAdapter;
  manual: ManualSignallingAdapter | null;
  broadcast: BroadcastSignallingAdapter | null;
  http: HttpSignallingAdapter | null;
} {
  if (mode === 'lab') {
    const broadcast = new BroadcastSignallingAdapter(roomId, role);
    return { adapter: broadcast, manual: null, broadcast, http: null };
  }
  if (mode === 'server') {
    const baseUrl = loadSignallingUrl();
    if (!baseUrl || !isHttpSignallingUrl(baseUrl)) {
      throw new Error(
        'WebRTC server signalling requires a signalling URL in Settings (e.g. http://127.0.0.1:8787).',
      );
    }
    const http = new HttpSignallingAdapter({ baseUrl, roomId, role });
    return { adapter: http, manual: null, broadcast: null, http };
  }
  const manual = new ManualSignallingAdapter(role);
  return { adapter: manual, manual, broadcast: null, http: null };
}

export function startWebRtcHost(
  input: StartInput,
  options: { signallingMode?: WebRtcSignallingMode } = {},
): WebRtcConnectHandle {
  const signallingMode = options.signallingMode ?? 'manual';
  if (signallingMode === 'lab' && !isWebRtcLabAvailable()) {
    throw new Error('WebRTC lab mode requires BroadcastChannel + RTCPeerConnection.');
  }
  if (signallingMode === 'server' && !isWebRtcServerSignallingAvailable()) {
    throw new Error(
      'WebRTC server mode requires RTCPeerConnection and a signalling URL in Settings.',
    );
  }

  const machine = new ConnectionStateMachine();
  machine.set('connecting');

  const roomId = input.fingerprint;
  const { adapter, manual, broadcast, http } = makeSignalling(
    signallingMode,
    'offer',
    roomId,
  );
  const transport = new WebRtcTransport({
    role: 'offer',
    signalling: adapter,
    iceServers: loadIceServers(),
  });
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
    signer: input.signer,
    authorizedSign: input.authorizedSign ?? null,
  });

  const pairingCode = session.startHost(transport, { seed: input.fingerprint });
  const unwire = wireSessionToMachine(session, transport, machine);

  let orchestrator: MatchOrchestrator | null = null;

  // PairingSession fires connect without awaiting; if ICE/DataChannel
  // never opens, surface a failed connection lifecycle instead of
  // leaving the UI on "connecting" forever.
  const failTimer = setTimeout(() => {
    if (machine.current() === 'connecting') {
      machine.set('failed');
      void session.disconnect('webrtc-connect-timeout').catch(() => undefined);
    }
  }, 60_000);

  const pollHandle = setInterval(() => {
    if (transport.isConnected() && session.current().state === 'hosting') {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      session.notifyTransportConnected();
      clearInterval(pollHandle);
      clearTimeout(failTimer);
    }
    if (session.current().state === 'closed') {
      clearInterval(pollHandle);
      clearTimeout(failTimer);
      if (machine.current() === 'connecting') {
        machine.set('failed');
      }
    }
  }, 50);

  const handle: WebRtcConnectHandle = {
    pairingCode,
    session,
    selfAgentId: input.agentId,
    envelopeAuth: input.envelopeAuth,
    pairingRole: 'host',
    signallingMode,
    signalling: manual,
    role: 'offer',
    get orchestrator() {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      return orchestrator;
    },
    state: 'hosting',
    takeOutboundBlob: () => {
      if (!manual) {
        return Promise.reject(new Error('Only manual Mode B exposes an outbound blob.'));
      }
      return manual.takeOutboundBlob();
    },
    applyInboundBlob: (blob: string) => {
      if (!manual) {
        throw new Error('Only manual Mode B accepts pasted blobs.');
      }
      manual.applyInboundBlob(blob);
    },
    connectionState: () => machine.current(),
    onConnectionStateChange: (handler) => machine.subscribe(handler),
    async disconnect(reason: string = 'user-requested') {
      clearInterval(pollHandle);
      clearTimeout(failTimer);
      unwire();
      broadcast?.close();
      http?.close();
      await session.disconnect(reason);
      if (machine.current() !== 'failed') {
        machine.set('disconnected');
      }
    },
  };

  session.onStateChange((snap) => {
    if (snap.state === 'hosting' || snap.state === 'joining') {
      handle.state = snap.state;
    } else if (snap.state === 'tcp-connected') {
      handle.state = 'tcp-connected';
    } else if (snap.state === 'connected') {
      handle.state = 'connected';
      clearTimeout(failTimer);
    } else if (snap.state === 'closed') {
      handle.state = 'joining';
    }
  });

  return handle;
}

export async function startWebRtcJoin(
  input: StartInput & {
    code: string;
    offerBlob?: string;
    signallingMode?: WebRtcSignallingMode;
  },
): Promise<WebRtcConnectHandle> {
  const signallingMode = input.signallingMode ?? 'manual';
  if (signallingMode === 'lab' && !isWebRtcLabAvailable()) {
    throw new Error('WebRTC lab mode requires BroadcastChannel + RTCPeerConnection.');
  }
  if (signallingMode === 'server' && !isWebRtcServerSignallingAvailable()) {
    throw new Error(
      'WebRTC server mode requires RTCPeerConnection and a signalling URL in Settings.',
    );
  }
  if (signallingMode === 'manual' && !input.offerBlob?.trim()) {
    throw new Error('Manual WebRTC join requires an offer blob.');
  }

  const machine = new ConnectionStateMachine();
  machine.set('connecting');

  const roomId = input.code;
  const { adapter, manual, broadcast, http } = makeSignalling(
    signallingMode,
    'answer',
    roomId,
  );
  if (manual && input.offerBlob) {
    manual.applyInboundBlob(input.offerBlob);
  }

  const transport = new WebRtcTransport({
    role: 'answer',
    signalling: adapter,
    iceServers: loadIceServers(),
  });
  const session = new PairingSession({
    agentId: input.agentId,
    displayName: input.displayName,
    signer: input.signer,
    authorizedSign: input.authorizedSign ?? null,
    expectedPeerFingerprint: input.code,
  });

  const unwire = wireSessionToMachine(session, transport, machine);
  let orchestrator: MatchOrchestrator | null = null;

  const failTimer = setTimeout(() => {
    if (machine.current() === 'connecting') {
      machine.set('failed');
      void session.disconnect('webrtc-connect-timeout').catch(() => undefined);
    }
  }, 60_000);

  const joinPromise = session
    .startJoin(transport, input.code)
    .then(() => {
      clearTimeout(failTimer);
      const snap = session.current();
      if (snap.state === 'tcp-connected' || snap.state === 'connected') {
        handle.state = snap.state;
      }
    })
    .catch((err: unknown) => {
      clearTimeout(failTimer);
      machine.set('failed');
      throw err;
    });

  const handle: WebRtcConnectHandle = {
    pairingCode: input.code,
    session,
    selfAgentId: input.agentId,
    envelopeAuth: input.envelopeAuth,
    pairingRole: 'join',
    signallingMode,
    signalling: manual,
    role: 'answer',
    get orchestrator() {
      if (!orchestrator) {
        orchestrator = new MatchOrchestrator(toOrchestratorSelf(input), '');
      }
      return orchestrator;
    },
    state: 'joining',
    takeOutboundBlob: () => {
      if (!manual) {
        return Promise.reject(new Error('Only manual Mode B exposes an outbound blob.'));
      }
      return manual.takeOutboundBlob();
    },
    applyInboundBlob: (blob: string) => {
      if (!manual) {
        throw new Error('Only manual Mode B accepts pasted blobs.');
      }
      manual.applyInboundBlob(blob);
    },
    connectionState: () => machine.current(),
    onConnectionStateChange: (handler) => machine.subscribe(handler),
    async disconnect(reason: string = 'user-requested') {
      clearTimeout(failTimer);
      unwire();
      broadcast?.close();
      http?.close();
      await joinPromise.catch(() => undefined);
      await session.disconnect(reason);
      if (machine.current() !== 'failed') {
        machine.set('disconnected');
      }
    },
  };

  return handle;
}
