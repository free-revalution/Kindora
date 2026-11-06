/**
 * PairingSession — the Phase A handshake, end to end (Phase A / A2 + A3).
 *
 * Two real sessions, two real transports, real ECDSA signatures and a
 * real ECDH key exchange. Nothing here is mocked: a handshake test
 * that stubs the crypto proves nothing about the handshake.
 *
 * What is pinned here:
 *
 *   1. both sides derive the same session key and switch the transport
 *      to encrypted mode;
 *   2. a peer whose fingerprint does not match the one the user was
 *      shown is rejected **immediately** — no data is exchanged;
 *   3. an unsigned envelope is dropped, and enough of them tear the
 *      session down.
 *
 * See 开发手册.md § 17, § 19.
 */
import { describe, it, expect } from 'vitest';
import {
  bytesToBase64,
  bytesToBase64Url,
  deriveKeyId,
  type EnvelopeSigner,
  type HelloPayload,
  type KsaMessage,
  type SessionKeyExchange,
} from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport } from '../loopback-transport';
import { PairingSession } from '../pairing-session';
import { derivePairingFingerprint } from '../pairing-fingerprint';

const HOST_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const JOIN_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

interface TestPeer {
  readonly agentId: string;
  readonly signer: EnvelopeSigner;
  readonly publicKeyBase64: string;
  readonly spki: Uint8Array;
}

/** A real ECDSA P-256 signer, wired the way `@kindora/agent` wires it. */
async function createPeer(agentId: string): Promise<TestPeer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
  const keyId = await deriveKeyId(spki);
  return {
    agentId,
    spki,
    publicKeyBase64: bytesToBase64(spki),
    signer: {
      agentId,
      publicKey: bytesToBase64(spki),
      keyId,
      async sign(input: Uint8Array): Promise<string> {
        const raw = await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          // `as BufferSource`: since TypeScript 5.7 a bare `Uint8Array` is
          // `Uint8Array<ArrayBufferLike>`, which is not assignable to the
          // DOM lib's `BufferSource` (`ArrayBufferView<ArrayBuffer> |
          // ArrayBuffer`) — even though every WebCrypto implementation
          // accepts it at runtime. The assertion is the supported way to
          // say "this view is fine".
          input as BufferSource,
        );
        return bytesToBase64Url(new Uint8Array(raw));
      },
    },
  };
}

function helloPayload(peer: TestPeer, exchange: SessionKeyExchange | null): HelloPayload {
  return {
    displayName: `peer-${peer.agentId.slice(0, 4)}`,
    capabilities: {
      protocolVersion: '0.1',
      supportsMatchAnalysis: true,
      supportsIcebreaker: true,
      supportsChatAssist: true,
      supportsMessageSigning: true,
      supportsSessionEncryption: exchange !== null,
      supportsTransportEncryption: false,
      supportsWebRtc: false,
    },
    publicKey: peer.publicKeyBase64,
    ...(exchange ? { sessionKeyExchange: exchange } : {}),
  };
}

function helloEnvelope(peer: TestPeer, exchange: SessionKeyExchange | null): KsaMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'hello',
    sender: peer.agentId,
    payload: helloPayload(peer, exchange),
  };
}

function chatEnvelope(sender: string, text: string): KsaMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: 'chat_message',
    sender,
    payload: { text },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Handshake {
  readonly hostSession: PairingSession;
  readonly joinSession: PairingSession;
  readonly hostTransport: LoopbackTransport;
  readonly joinTransport: LoopbackTransport;
  readonly host: TestPeer;
  readonly joiner: TestPeer;
  readonly fingerprint: string;
}

/**
 * Run the whole handshake over a loopback hub.
 *
 * @param expectedFingerprint what the joiner believes the host's
 *        fingerprint is. Pass a wrong one to exercise the mismatch path.
 */
async function handshake(expectedFingerprint?: string): Promise<Handshake> {
  const hub = new LoopbackHub();
  const host = await createPeer(HOST_ID);
  const joiner = await createPeer(JOIN_ID);
  const fingerprint = await derivePairingFingerprint(host.agentId, host.spki);

  const hostTransport = new LoopbackTransport({ endpointId: host.agentId, hub });
  const joinTransport = new LoopbackTransport({ endpointId: joiner.agentId, hub });

  const hostSession = new PairingSession({
    agentId: host.agentId,
    displayName: 'host',
    signer: host.signer,
  });
  const joinSession = new PairingSession({
    agentId: joiner.agentId,
    displayName: 'joiner',
    signer: joiner.signer,
    expectedPeerFingerprint: expectedFingerprint ?? fingerprint,
  });

  // The orchestrator's job: once a validated `hello` arrives, tell the
  // session who the peer is.
  for (const session of [hostSession, joinSession]) {
    session.onMessage((message) => {
      if (message.type === 'hello') {
        try {
          session.notifyHelloReceived(message.sender);
        } catch {
          // The session may already be past `tcp-connected`; the test
          // asserts on the state, not on this call.
        }
      }
    });
  }

  // 1 — the host opens the room under its own fingerprint.
  hostSession.startHost(hostTransport, { seed: fingerprint });

  // 2 — the joiner dials the same fingerprint, which pairs the two.
  await joinSession.startJoin(joinTransport, fingerprint);

  // 3 — the host learns the wire is up.
  hostSession.notifyTransportConnected();

  // 4 — both sides send their `hello`, carrying their identity key and
  //     their ephemeral key offer.
  const hostExchange = await hostSession.sessionKeyExchange();
  const joinExchange = await joinSession.sessionKeyExchange();
  await hostSession.send(helloEnvelope(host, hostExchange));
  await joinSession.send(helloEnvelope(joiner, joinExchange));

  return {
    hostSession,
    joinSession,
    hostTransport,
    joinTransport,
    host,
    joiner,
    fingerprint,
  };
}

describe('pairing session — signed and encrypted handshake', () => {
  it('brings both sides to an encrypted, connected session', async () => {
    const { hostSession, joinSession, fingerprint } = await handshake();

    await waitFor(
      () => hostSession.current().sessionEncrypted && joinSession.current().sessionEncrypted,
      'both sessions to become encrypted',
    );

    expect(hostSession.current().sessionEncrypted).toBe(true);
    expect(joinSession.current().sessionEncrypted).toBe(true);
    expect(hostSession.current().peerAgentId).toBe(JOIN_ID);
    expect(joinSession.current().peerAgentId).toBe(HOST_ID);
    expect(fingerprint).toHaveLength(6);

    await hostSession.disconnect();
    await joinSession.disconnect();
  });

  it('carries an encrypted message from one side to the other', async () => {
    const { hostSession, joinSession } = await handshake();
    await waitFor(
      () => hostSession.current().sessionEncrypted && joinSession.current().sessionEncrypted,
      'both sessions to become encrypted',
    );

    const received: KsaMessage[] = [];
    joinSession.onMessage((message) => received.push(message));

    await hostSession.send(chatEnvelope(HOST_ID, 'a message that must be encrypted'));

    await waitFor(() => received.length > 0, 'the encrypted message to arrive');
    const first = received[0];
    expect(first?.type).toBe('chat_message');
    if (!first || first.type !== 'chat_message') throw new Error('expected a chat_message');
    expect(first.payload.text).toBe('a message that must be encrypted');

    await hostSession.disconnect();
    await joinSession.disconnect();
  });

  it('rejects a peer whose fingerprint is not the one the user was shown', async () => {
    // The joiner believes the host is 'ZZZZZZ'. It is not.
    const { joinSession, joinTransport } = await handshake('ZZZZZZ');

    await waitFor(
      () => joinSession.current().state === 'closed',
      'the joiner to close the session',
    );

    expect(joinSession.current().closeReason).toBe('peer-fingerprint-mismatch');
    expect(joinSession.current().sessionEncrypted).toBe(false);
    expect(joinTransport.isConnected()).toBe(false);
  });

  it('drops an unsigned envelope and tears the session down after three of them', async () => {
    const { hostSession, joinSession, joinTransport, joiner } = await handshake();
    await waitFor(
      () => hostSession.current().sessionEncrypted && joinSession.current().sessionEncrypted,
      'both sessions to become encrypted',
    );

    const received: KsaMessage[] = [];
    hostSession.onMessage((message) => received.push(message));

    // Bypass the session so the envelope goes out **unsigned**.
    for (let i = 0; i < 3; i++) {
      await joinTransport.send(chatEnvelope(joiner.agentId, `unsigned ${i}`));
    }

    await waitFor(
      () => hostSession.current().state === 'closed',
      'the receiving session to close after three bad signatures',
    );
    expect(hostSession.current().closeReason).toBe('signature-invalid');
    // Not one of the unsigned messages reached a handler.
    expect(received).toHaveLength(0);

    await joinSession.disconnect();
  });
});
