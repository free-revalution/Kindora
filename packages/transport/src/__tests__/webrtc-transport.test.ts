/**
 * Phase G — the WebRTC transport is an explicit `NOT_IMPLEMENTED`
 * stub, and it must never pretend otherwise.
 *
 * `docs/修复.md` § 十 (Phase G) asks for three test cases:
 *
 *   1. 未实现时调用 WebRTC 应返回明确的功能未实现错误。
 *   2. 不得出现虚假的连接成功状态。
 *   3. 能力声明与真实实现一致。
 *
 * The third one is a cross-check between two packages: the capability
 * flag lives in `@kindora/protocol`, the implementation lives here.
 * If either side drifts — the flag flips to `true` while the stub
 * still throws, or the stub starts working while the flag stays
 * `false` — this suite fails.
 *
 * See `packages/transport/src/webrtc-transport.ts` for the contract
 * the real implementation has to satisfy.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENT_CAPABILITIES, type KsaMessage } from '@kindora/protocol';
import {
  WEBRTC_NOT_IMPLEMENTED_CODE,
  WebRtcNotImplementedError,
  WebRtcTransport,
  type WebRtcSignallingAdapter,
  type WebRtcSignallingEvent,
} from '../webrtc-transport';
import type { PeerInfo, Transport } from '../index';

const PEER: PeerInfo = {
  agentId: '33333333-3333-4333-8333-cccccccccccc',
  displayName: 'Sam',
  hint: 'ABCD12',
};

const MESSAGE = {
  protocol: 'KSA',
  version: '0.1',
  messageId: '11111111-2222-4333-8444-555555555555',
  type: 'chat_message',
  sender: '44444444-4444-4444-8444-dddddddddddd',
  timestamp: '2026-01-01T00:00:00.000Z',
  payload: { text: 'hi' },
} as unknown as KsaMessage;

describe('@kindora/transport — Phase G: the WebRTC stub', () => {
  it('connect() rejects with a typed not-implemented error', async () => {
    const transport = new WebRtcTransport();
    await expect(transport.connect(PEER)).rejects.toBeInstanceOf(WebRtcNotImplementedError);
  });

  it('the error carries the stable WEBRTC_NOT_IMPLEMENTED code', async () => {
    const transport = new WebRtcTransport();
    const err = await transport.connect(PEER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebRtcNotImplementedError);
    expect((err as WebRtcNotImplementedError).code).toBe(WEBRTC_NOT_IMPLEMENTED_CODE);
    expect((err as WebRtcNotImplementedError).name).toBe('WebRtcNotImplementedError');
  });

  it('the error message points at the Phase G documentation', async () => {
    const transport = new WebRtcTransport();
    const err = await transport.connect(PEER).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/not implemented/i);
    expect((err as Error).message).toContain('Phase G');
    // It must also say what to use instead — a dead end is not a good
    // error message.
    expect((err as Error).message).toMatch(/LoopbackTransport|LanTransport/);
  });

  it('send() rejects with the same typed error — there is no DataChannel', async () => {
    const transport = new WebRtcTransport();
    await expect(transport.send(MESSAGE)).rejects.toBeInstanceOf(WebRtcNotImplementedError);
  });

  it('onMessage() throws the same typed error', () => {
    const transport = new WebRtcTransport();
    expect(() => transport.onMessage(() => undefined)).toThrow(WebRtcNotImplementedError);
  });

  it('onClose() throws the same typed error — there is no live link to close', () => {
    const transport = new WebRtcTransport();
    expect(() => transport.onClose(() => undefined)).toThrow(WebRtcNotImplementedError);
  });

  it('connect() never resolves — there is no false "connected" state', async () => {
    const transport = new WebRtcTransport();
    let resolved = false;
    const outcome = await transport.connect(PEER).then(
      () => {
        resolved = true;
        return 'resolved';
      },
      () => 'rejected',
    );
    expect(outcome).toBe('rejected');
    expect(resolved).toBe(false);
  });

  it('disconnect() is safe even after a failed connect()', async () => {
    const transport = new WebRtcTransport();
    await expect(transport.connect(PEER)).rejects.toBeInstanceOf(WebRtcNotImplementedError);
    // Tearing down must not throw a second, confusing error.
    await expect(transport.disconnect()).resolves.toBeUndefined();
  });

  it('never fires a close handler — there is nothing that could close', async () => {
    const transport = new WebRtcTransport();
    let closed = false;
    // Registering a close handler is itself refused, so `closed` can
    // never become true.
    expect(() =>
      transport.onClose(() => {
        closed = true;
      }),
    ).toThrow(WebRtcNotImplementedError);
    await transport.disconnect();
    expect(closed).toBe(false);
  });

  it('satisfies the Transport interface', () => {
    const transport: Transport = new WebRtcTransport();
    expect(typeof transport.connect).toBe('function');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.onClose).toBe('function');
    expect(typeof transport.disconnect).toBe('function');
  });

  it('the declared capability agrees with the implementation', async () => {
    // The capability flag says "no WebRTC" …
    expect(DEFAULT_AGENT_CAPABILITIES.supportsWebRtc).toBe(false);
    // … and the implementation agrees: it refuses to connect.
    const transport = new WebRtcTransport();
    await expect(transport.connect(PEER)).rejects.toBeInstanceOf(WebRtcNotImplementedError);
  });

  it('accepts the follow-up signalling contract without pretending to use it', async () => {
    // Phase G requirement 4 — the contract for the next implementation
    // is locked in. The stub takes the options and still refuses.
    const seen: WebRtcSignallingEvent[] = [];
    const signalling: WebRtcSignallingAdapter = {
      exchangeDescription: async () => ({ type: 'offer', sdp: 'v=0' }),
      sendCandidate: async () => undefined,
      onRemote: (handler) => {
        handler({ type: 'candidate', candidate: null });
        return () => undefined;
      },
    };

    const transport = new WebRtcTransport({
      signalling,
      iceServers: ['stun:stun.l.google.com:19302'],
    });

    // Constructing it is fine; using it is still not.
    expect(transport).toBeInstanceOf(WebRtcTransport);
    await expect(transport.connect(PEER)).rejects.toBeInstanceOf(WebRtcNotImplementedError);

    // The adapter itself is a working object — it is the *transport* that
    // refuses to use it. Drive the adapter directly, the way the
    // follow-up implementation will.
    const unsubscribe = signalling.onRemote((event) => {
      seen.push(event);
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'candidate', candidate: null });
    unsubscribe();
  });
});
