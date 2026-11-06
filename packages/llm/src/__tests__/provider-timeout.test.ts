/**
 * The request timeout, against a **real socket**.
 *
 * Every other timeout test in this package is a mock. This one opens a real
 * TCP listener, lets the request connect, and then stalls — so the deadline,
 * the abort and the `TIMEOUT_ERROR` classification are exercised through the
 * actual network stack instead of a stubbed `fetch`.
 *
 * It needs no API key and no external service, so it is **not** part of the
 * live provider suites (`providers.live.test.ts`): it always runs, and it
 * always means the same thing. The provider-side timeout (a request the
 * provider has already started) is deliberately *not* covered here — aborting
 * that one may still bill us, which is exactly why a timeout is not retried
 * (see `src/errors.ts`).
 */

import { describe, it, expect } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { OpenAICompatibleProvider } from '../index';

const PROMPT: readonly { role: 'user'; content: string }[] = [
  { role: 'user', content: 'Reply with exactly the word "ok" and nothing else.' },
];

/**
 * A server that accepts the connection and never answers.
 *
 * The accepted sockets are tracked so that shutting the server down does not
 * wait for a connection that never ends. `net.Server` has no
 * `closeAllConnections()` in `@types/node` (only `http.Server` does), so the
 * sockets are destroyed explicitly.
 */
async function startStalledServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    // The socket is destroyed while the client is still attached; without an
    // error listener that surfaces as an unhandled 'error' event and takes the
    // whole test process down.
    socket.on('error', () => {
      /* the peer went away — expected in this test */
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('@kindora/llm — timeout against a real socket', () => {
  it('gives up on a server that accepts the connection and then stalls', async () => {
    const server = await startStalledServer();
    try {
      const provider = new OpenAICompatibleProvider({
        baseUrl: server.baseUrl,
        model: 'm',
        timeoutMs: 300,
      });
      const err = (await provider.chat(PROMPT).catch((e: unknown) => e)) as { code?: string };
      expect(err.code).toBe('TIMEOUT_ERROR');
    } finally {
      await server.close();
    }
  });
});
