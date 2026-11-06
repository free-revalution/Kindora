/**
 * Anti-replay protection (Phase A / A3).
 *
 * Task book A3.8 requires message replay protection ("实现消息重放保护"),
 * its test case requires "重放历史握手数据时连接失败", and the final
 * acceptance checklist requires a replay attack test to pass.
 *
 * Four properties are pinned here:
 *
 *   1. an envelope whose `messageId` has already been accepted is
 *      dropped — it never reaches a message handler;
 *   2. an envelope whose timestamp is outside the freshness window
 *      (too old, or too far in the future) is dropped as well;
 *   3. an envelope with a *fresh* messageId is still delivered — the
 *      guard does not over-block ordinary traffic;
 *   4. with the guard switched off, the same replay **is** delivered —
 *      which is what proves assertions 1–3 are caused by the replay
 *      guard and by nothing else.
 *
 * The sessions here are deliberately **signer-less**. With a signer
 * installed, an unsigned replay would be rejected by the *signature*
 * check and the replay guard would never be exercised at all. A session
 * without a signer is a legitimate configuration (it means "this runtime
 * has no usable WebCrypto"), and it must not be left without replay
 * protection — which is exactly why the guard is consulted before the
 * signature check.
 *
 * See 开发手册.md § 54, and `docs/REMEDIATION_TEST_REPORT.md` § 8.3.
 */
import { describe, it, expect } from 'vitest';
import type { KsaMessage } from '@kindora/protocol';
import { LoopbackHub, LoopbackTransport } from '../loopback-transport';
import { PairingSession, type PairingSessionOptions } from '../pairing-session';

const HOST_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const JOIN_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

/** Comfortably outside the five-minute freshness window. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/** A valid KSA `chat_message` envelope. */
function chatEnvelope(
  sender: string,
  text: string,
  messageId: string,
  timestamp: string,
): KsaMessage {
  return {
    protocol: 'KSA',
    version: '0.1',
    messageId,
    timestamp,
    type: 'chat_message',
    sender,
    payload: { text },
  };
}

interface Fixture {
  readonly hostSession: PairingSession;
  readonly joinSession: PairingSession;
  readonly received: KsaMessage[];
}

/**
 * Build the options for one side of the pair.
 *
 * `replayGuard: null` switches the guard off — that is what the
 * control test needs; the other tests leave it at its default.
 */
function sessionOptions(
  agentId: string,
  displayName: string,
  guardOff: boolean,
): PairingSessionOptions {
  return guardOff ? { agentId, displayName, replayGuard: null } : { agentId, displayName };
}

/**
 * Two signer-less sessions, paired over a loopback hub.
 */
async function pairSessions(
  options: { readonly replayGuard?: 'default' | 'off' } = {},
): Promise<Fixture> {
  const guardOff = options.replayGuard === 'off';
  const hub = new LoopbackHub();
  const hostTransport = new LoopbackTransport({ endpointId: HOST_ID, hub });
  const joinTransport = new LoopbackTransport({ endpointId: JOIN_ID, hub });

  const hostSession = new PairingSession(sessionOptions(HOST_ID, 'host', guardOff));
  const joinSession = new PairingSession(sessionOptions(JOIN_ID, 'joiner', guardOff));

  // The host enters the room; the joiner pairs with it. After
  // `startJoin` resolves, the two transports are paired and the join
  // session is in `tcp-connected` — enough to send.
  const code = hostSession.startHost(hostTransport);
  await joinSession.startJoin(joinTransport, code);

  const received: KsaMessage[] = [];
  hostSession.onMessage((message) => received.push(message));

  return { hostSession, joinSession, received };
}

describe('pairing session — anti-replay protection', () => {
  it('drops a replayed envelope instead of delivering it twice', async () => {
    const { hostSession, joinSession, received } = await pairSessions();

    const envelope = chatEnvelope(
      JOIN_ID,
      'the same message twice',
      crypto.randomUUID(),
      new Date().toISOString(),
    );

    await joinSession.send(envelope);
    expect(received).toHaveLength(1);
    expect(hostSession.replayRejectionCount()).toBe(0);

    // The exact same envelope, replayed. It must never reach a handler.
    await joinSession.send(envelope);
    expect(received).toHaveLength(1);
    expect(hostSession.replayRejectionCount()).toBe(1);
  });

  it('drops an envelope whose timestamp is outside the freshness window', async () => {
    const { hostSession, joinSession, received } = await pairSessions();

    // One hour old — well past the five-minute freshness window.
    const stale = new Date(Date.now() - ONE_HOUR_MS).toISOString();
    await joinSession.send(chatEnvelope(JOIN_ID, 'stale', crypto.randomUUID(), stale));
    expect(received).toHaveLength(0);
    expect(hostSession.replayRejectionCount()).toBe(1);
  });

  it('drops an envelope whose timestamp is too far in the future', async () => {
    const { hostSession, joinSession, received } = await pairSessions();

    // One hour ahead of us — well past the five-minute skew allowance.
    const future = new Date(Date.now() + ONE_HOUR_MS).toISOString();
    await joinSession.send(chatEnvelope(JOIN_ID, 'from the future', crypto.randomUUID(), future));
    expect(received).toHaveLength(0);
    expect(hostSession.replayRejectionCount()).toBe(1);
  });

  it('still delivers an envelope with a fresh messageId', async () => {
    // The guard must not over-block ordinary traffic: a second,
    // *different* message with a current timestamp goes through even
    // though the first one is already in the dedup set.
    const { hostSession, joinSession, received } = await pairSessions();

    await joinSession.send(
      chatEnvelope(JOIN_ID, 'first', crypto.randomUUID(), new Date().toISOString()),
    );
    await joinSession.send(
      chatEnvelope(JOIN_ID, 'second', crypto.randomUUID(), new Date().toISOString()),
    );

    expect(received).toHaveLength(2);
    expect(hostSession.replayRejectionCount()).toBe(0);
  });

  it('delivers the replay when the guard is switched off', async () => {
    // This is the control: it proves the assertions above are caused
    // by the replay guard and by nothing else.
    const { hostSession, joinSession, received } = await pairSessions({
      replayGuard: 'off',
    });

    const envelope = chatEnvelope(
      JOIN_ID,
      'the same message twice',
      crypto.randomUUID(),
      new Date().toISOString(),
    );

    await joinSession.send(envelope);
    await joinSession.send(envelope);

    expect(received).toHaveLength(2);
    expect(hostSession.replayRejectionCount()).toBe(0);
  });
});
