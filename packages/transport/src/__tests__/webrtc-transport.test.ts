/**
 * Phase G / Mode B — WebRTC transport.
 *
 * Without a signalling adapter (or without RTCPeerConnection), connect
 * refuses with WebRtcNotImplementedError so capability advertising stays
 * honest. With a factory + ManualSignallingAdapter, a mocked peer
 * connection can complete the handshake in unit tests.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PeerInfo, Transport } from '../index';
import {
  WebRtcNotImplementedError,
  WebRtcTransport,
  WEBRTC_NOT_IMPLEMENTED_CODE,
  isWebRtcAvailable,
  ManualSignallingAdapter,
  decodeManualSignalBlob,
  encodeManualSignalBlob,
  MANUAL_SIGNAL_BLOB_VERSION,
  type WebRtcSignallingAdapter,
  type WebRtcSignallingEvent,
} from '../index';
import { DEFAULT_AGENT_CAPABILITIES } from '@kindora/protocol';

const PEER: PeerInfo = {
  agentId: 'peer-1',
  displayName: 'Peer',
};

describe('WebRtcTransport — availability gate', () => {
  it('throws WebRtcNotImplementedError when no signalling is provided', async () => {
    const transport = new WebRtcTransport();
    await expect(transport.connect(PEER)).rejects.toBeInstanceOf(WebRtcNotImplementedError);
    try {
      await new WebRtcTransport().connect(PEER);
    } catch (err) {
      expect(err).toBeInstanceOf(WebRtcNotImplementedError);
      expect((err as WebRtcNotImplementedError).code).toBe(WEBRTC_NOT_IMPLEMENTED_CODE);
    }
  });

  it('throws when signalling is set but RTCPeerConnection is missing', async () => {
    const signalling: WebRtcSignallingAdapter = {
      exchangeDescription: async () => ({ type: 'offer', sdp: 'v=0' }),
      sendCandidate: async () => undefined,
      onRemote: () => () => undefined,
    };
    // Force "unavailable" by not injecting a factory; jsdom usually has no RTC.
    if (isWebRtcAvailable()) {
      // Real browser — skip this branch; the next test covers the happy path.
      return;
    }
    const transport = new WebRtcTransport({ signalling, role: 'offer' });
    await expect(transport.connect(PEER)).rejects.toMatchObject({
      code: WEBRTC_NOT_IMPLEMENTED_CODE,
    });
  });

  it('satisfies the Transport interface', () => {
    const transport: Transport = new WebRtcTransport();
    expect(typeof transport.connect).toBe('function');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.onMessage).toBe('function');
    expect(typeof transport.onClose).toBe('function');
    expect(typeof transport.disconnect).toBe('function');
  });

  it('DEFAULT capability stays false; runtime may flip via RTCPeerConnection', () => {
    expect(DEFAULT_AGENT_CAPABILITIES.supportsWebRtc).toBe(false);
  });

  it('accepts the signalling contract', async () => {
    const seen: WebRtcSignallingEvent[] = [];
    const signalling: WebRtcSignallingAdapter = {
      exchangeDescription: async () => ({ type: 'offer', sdp: 'v=0' }),
      sendCandidate: async () => undefined,
      onRemote: (handler) => {
        handler({ type: 'candidate', candidate: null });
        return () => undefined;
      },
    };
    const transport = new WebRtcTransport({ signalling, iceServers: ['stun:stun.l.google.com:19302'] });
    expect(transport).toBeInstanceOf(WebRtcTransport);
    const unsubscribe = signalling.onRemote((event) => {
      seen.push(event);
    });
    expect(seen).toHaveLength(1);
    unsubscribe();
  });
});

describe('ManualSignallingAdapter — blob encode/decode', () => {
  it('round-trips an offer blob', () => {
    const blob = encodeManualSignalBlob({
      v: MANUAL_SIGNAL_BLOB_VERSION,
      role: 'offer',
      description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' },
      candidates: [{ candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host', sdpMid: '0' }],
    });
    const decoded = decodeManualSignalBlob(blob);
    expect(decoded.role).toBe('offer');
    expect(decoded.description.type).toBe('offer');
    expect(decoded.candidates).toHaveLength(1);
  });

  it('rejects empty / garbage blobs', () => {
    expect(() => decodeManualSignalBlob('')).toThrow();
    expect(() => decodeManualSignalBlob('%%%not-base64%%%')).toThrow();
  });

  it('buffers remote events for late subscribers', () => {
    const adapter = new ManualSignallingAdapter('answer');
    adapter.provideRemoteDescription({ type: 'offer', sdp: 'v=0' });
    const seen: WebRtcSignallingEvent[] = [];
    adapter.onRemote((e) => seen.push(e));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('description');
  });

  it('takeOutboundBlob resolves after exchangeDescription', async () => {
    const adapter = new ManualSignallingAdapter('offer');
    const pending = adapter.takeOutboundBlob();
    const remotePromise = adapter.exchangeDescription({ type: 'offer', sdp: 'v=0' });
    const blob = await pending;
    expect(blob.length).toBeGreaterThan(8);
    adapter.provideRemoteDescription({ type: 'answer', sdp: 'v=0' });
    await remotePromise;
  });
});

describe('WebRtcTransport — mocked peer connection', () => {
  it('opens a DataChannel through a factory + manual signalling', async () => {
    type Handler = ((ev: unknown) => void) | null;

    class FakeChannel {
      readyState = 'connecting';
      onopen: Handler = null;
      onmessage: Handler = null;
      onclose: Handler = null;
      onerror: Handler = null;
      send = vi.fn();
      close = vi.fn();
      open(): void {
        this.readyState = 'open';
        this.onopen?.({});
      }
    }

    class FakePC {
      iceGatheringState = 'gathering';
      connectionState = 'new';
      localDescription: RTCSessionDescriptionInit | null = null;
      remoteDescription: RTCSessionDescriptionInit | null = null;
      onicecandidate: Handler = null;
      onconnectionstatechange: Handler = null;
      ondatachannel: Handler = null;
      private channel = new FakeChannel();
      private gatheringHandlers = new Set<() => void>();

      createDataChannel = vi.fn(() => this.channel);
      createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'offer-sdp' }));
      createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'answer-sdp' }));
      setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
        this.localDescription = d;
        queueMicrotask(() => {
          this.iceGatheringState = 'complete';
          for (const h of this.gatheringHandlers) h();
        });
      });
      setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
        this.remoteDescription = d;
      });
      addIceCandidate = vi.fn(async () => undefined);
      close = vi.fn();
      addEventListener = (type: string, handler: () => void) => {
        if (type === 'icegatheringstatechange') this.gatheringHandlers.add(handler);
      };
      removeEventListener = (type: string, handler: () => void) => {
        if (type === 'icegatheringstatechange') this.gatheringHandlers.delete(handler);
      };

      /** Test helper — open the offerer's channel after answer is set. */
      openChannel(): void {
        this.channel.open();
      }
    }

    const offerPc = new FakePC();
    const answerPc = new FakePC();
    const offerSig = new ManualSignallingAdapter('offer');
    const answerSig = new ManualSignallingAdapter('answer');

    const offerTransport = new WebRtcTransport({
      role: 'offer',
      signalling: offerSig,
      peerConnectionFactory: () => offerPc as unknown as RTCPeerConnection,
      connectTimeoutMs: 5_000,
    });
    const answerTransport = new WebRtcTransport({
      role: 'answer',
      signalling: answerSig,
      peerConnectionFactory: () => answerPc as unknown as RTCPeerConnection,
      connectTimeoutMs: 5_000,
    });

    // When the answerer sets the remote offer, deliver a fake remote channel.
    const originalSetRemote = answerPc.setRemoteDescription.bind(answerPc);
    answerPc.setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => {
      await originalSetRemote(d);
      queueMicrotask(() => {
        const ch = new FakeChannel();
        answerPc.ondatachannel?.({ channel: ch });
        // Open shortly after the handler wires onopen.
        queueMicrotask(() => ch.open());
      });
    });

    const offerConnect = offerTransport.connect(PEER);
    const offerBlob = await offerSig.takeOutboundBlob();
    answerSig.applyInboundBlob(offerBlob);

    const answerConnect = answerTransport.connect(PEER);
    const answerBlob = await answerSig.takeOutboundBlob();
    offerSig.applyInboundBlob(answerBlob);

    // Offerer's locally-created channel opens once the answer is applied.
    queueMicrotask(() => offerPc.openChannel());

    await Promise.all([offerConnect, answerConnect]);
    expect(offerTransport.isConnected()).toBe(true);
    expect(answerTransport.isConnected()).toBe(true);

    await offerTransport.disconnect();
    await answerTransport.disconnect();
  }, 15_000);
});
