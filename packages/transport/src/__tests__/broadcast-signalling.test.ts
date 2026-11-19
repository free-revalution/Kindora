import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { BroadcastSignallingAdapter, isBroadcastSignallingAvailable } from '../broadcast-signalling';

class FakeBroadcastChannel {
  static rooms = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((ev: MessageEvent) => void) | null = null;
  constructor(private readonly name: string) {
    let set = FakeBroadcastChannel.rooms.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.rooms.set(name, set);
    }
    set.add(this);
  }
  postMessage(data: unknown): void {
    const peers = FakeBroadcastChannel.rooms.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer === this) continue;
      peer.onmessage?.({ data } as MessageEvent);
    }
  }
  close(): void {
    FakeBroadcastChannel.rooms.get(this.name)?.delete(this);
  }
}

describe('BroadcastSignallingAdapter', () => {
  const original = globalThis.BroadcastChannel;

  beforeEach(() => {
    FakeBroadcastChannel.rooms.clear();
    // @ts-expect-error test seam
    globalThis.BroadcastChannel = FakeBroadcastChannel;
  });

  afterEach(() => {
    globalThis.BroadcastChannel = original;
  });

  it('reports availability when BroadcastChannel exists', () => {
    expect(isBroadcastSignallingAvailable()).toBe(true);
  });

  it('relays offer → answer descriptions across the channel', async () => {
    const offer = new BroadcastSignallingAdapter('room-1', 'offer');
    const answer = new BroadcastSignallingAdapter('room-1', 'answer');

    const answerGot = new Promise<RTCSessionDescriptionInit>((resolve) => {
      answer.onRemote((ev) => {
        if (ev.type === 'description') resolve(ev.description);
      });
    });

    const remoteForOffer = offer.exchangeDescription({ type: 'offer', sdp: 'offer-sdp' });
    const got = await answerGot;
    expect(got.sdp).toBe('offer-sdp');

    await answer.exchangeDescription({ type: 'answer', sdp: 'answer-sdp' });
    const remote = await remoteForOffer;
    expect(remote.sdp).toBe('answer-sdp');

    offer.close();
    answer.close();
  });

  it('re-posts local description when a late peer sends need', async () => {
    const offer = new BroadcastSignallingAdapter('room-2', 'offer');
    void offer.exchangeDescription({ type: 'offer', sdp: 'early-offer' });

    const answer = new BroadcastSignallingAdapter('room-2', 'answer');
    const got = await new Promise<RTCSessionDescriptionInit>((resolve) => {
      answer.onRemote((ev) => {
        if (ev.type === 'description') resolve(ev.description);
      });
    });
    expect(got.sdp).toBe('early-offer');
    offer.close();
    answer.close();
  });
});
