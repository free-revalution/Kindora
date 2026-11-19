import { describe, it, expect, vi } from 'vitest';
import { HttpSignallingAdapter, isHttpSignallingUrl } from '../http-signalling';

describe('@kindora/transport — HttpSignallingAdapter', () => {
  it('accepts http(s) base URLs only', () => {
    expect(isHttpSignallingUrl('http://127.0.0.1:8787')).toBe(true);
    expect(isHttpSignallingUrl('https://signal.example')).toBe(true);
    expect(isHttpSignallingUrl('ws://127.0.0.1')).toBe(false);
    expect(isHttpSignallingUrl('not-a-url')).toBe(false);
  });

  it('posts the local description and resolves when the peer answer arrives', async () => {
    const store: Array<Record<string, unknown>> = [];
    let after = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/join') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        store.push({ id: store.length, ...body });
        return new Response(JSON.stringify({ ok: true, id: store.length - 1 }), { status: 200 });
      }
      if (url.includes('/messages') && (init?.method === 'GET' || !init?.method)) {
        const u = new URL(url, 'http://local.test');
        after = Number(u.searchParams.get('after') ?? '0');
        const pending = store.filter((m) => Number(m.id) >= after && m.from !== 'offer');
        return new Response(JSON.stringify({ messages: pending }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;

    const offer = new HttpSignallingAdapter({
      baseUrl: 'http://127.0.0.1:8787',
      roomId: 'ABC123',
      role: 'offer',
      fetchImpl,
      pollIntervalMs: 20,
    });

    const answerDesc = { type: 'answer' as const, sdp: 'v=0' };
    // Simulate the answerer posting after the offer starts waiting.
    setTimeout(() => {
      store.push({
        id: store.length,
        from: 'answer',
        kind: 'description',
        description: answerDesc,
      });
    }, 30);

    const remote = await offer.exchangeDescription({ type: 'offer', sdp: 'v=0-offer' });
    expect(remote).toEqual(answerDesc);
    expect(store.some((m) => m.from === 'offer' && m.kind === 'description')).toBe(true);
    offer.close();
  });

  it('replays a buffered remote description to late onRemote subscribers', async () => {
    const store: Array<Record<string, unknown>> = [
      {
        id: 0,
        from: 'offer',
        kind: 'description',
        description: { type: 'offer', sdp: 'v=0-early' },
      },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/join') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes('/messages') && (init?.method === 'GET' || !init?.method)) {
        const pending = store.splice(0);
        return new Response(JSON.stringify({ messages: pending }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const answer = new HttpSignallingAdapter({
      baseUrl: 'http://127.0.0.1:8787',
      roomId: 'ROOM',
      role: 'answer',
      fetchImpl,
      pollIntervalMs: 10,
    });

    await new Promise((r) => setTimeout(r, 40));

    const got = await new Promise<RTCSessionDescriptionInit>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 500);
      answer.onRemote((ev) => {
        if (ev.type === 'description') {
          clearTimeout(t);
          resolve(ev.description);
        }
      });
    });
    expect(got).toEqual({ type: 'offer', sdp: 'v=0-early' });
    answer.close();
  });
});
