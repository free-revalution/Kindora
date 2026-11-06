import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import {
  AnthropicProvider,
  LLMError,
  OllamaProvider,
  OpenAICompatibleProvider,
  isLLMError,
  redactSecrets,
  type ChatMessage,
  type LLMProvider,
} from '../index';

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello.' },
];

/**
 * Answer every request with the same status and body.
 *
 * A **new** `Response` per call: a `Response` body can only be read once,
 * so a single reused instance would make the second attempt fail with
 * "body is unusable" instead of the status we are testing.
 */
function alwaysRespond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        statusText: 'Error',
        headers: { 'Content-Type': 'application/json', ...headers },
      }),
  );
}

/** A `fetch` that accepts the request and then never answers. */
function stallForever(): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      }),
  );
}

/** Record the backoff delays instead of waiting for them. */
function recordingSleep(delays: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    delays.push(ms);
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('@kindora/llm — the unified error model', () => {
  it('every provider failure is an LLMError with a code', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      sleep: async () => {},
    });

    const err = await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(isLLMError(err)).toBe(true);
    expect((err as LLMError).code).toBe('NETWORK_ERROR');
  });

  it('exposes the seven codes the task book prescribes', () => {
    const codes = [
      'AUTHENTICATION_ERROR',
      'RATE_LIMIT_ERROR',
      'TIMEOUT_ERROR',
      'NETWORK_ERROR',
      'INVALID_RESPONSE',
      'PROVIDER_ERROR',
      'ABORTED',
    ] as const;
    for (const code of codes) {
      const err = new LLMError(code, `message for ${code}`);
      expect(err.code).toBe(code);
      expect(err.name).toBe('LLMError');
      expect(err instanceof Error).toBe(true);
    }
  });

  it('marks only the transient codes as retryable by default', () => {
    expect(new LLMError('RATE_LIMIT_ERROR', 'x').retryable).toBe(true);
    expect(new LLMError('NETWORK_ERROR', 'x').retryable).toBe(true);
    expect(new LLMError('AUTHENTICATION_ERROR', 'x').retryable).toBe(false);
    expect(new LLMError('TIMEOUT_ERROR', 'x').retryable).toBe(false);
    expect(new LLMError('INVALID_RESPONSE', 'x').retryable).toBe(false);
    expect(new LLMError('PROVIDER_ERROR', 'x').retryable).toBe(false);
    expect(new LLMError('ABORTED', 'x').retryable).toBe(false);
  });
});

describe('@kindora/llm — credential redaction', () => {
  it('removes the exact key we hold', () => {
    const out = redactSecrets('the key sk-live-abcdef123456 was rejected', [
      'sk-live-abcdef123456',
    ]);
    expect(out).not.toContain('sk-live-abcdef123456');
    expect(out).toContain('[redacted]');
  });

  it('removes a bearer token that is not ours', () => {
    const out = redactSecrets('Authorization: Bearer abcdef123456ZZ', []);
    expect(out).not.toContain('abcdef123456ZZ');
    expect(out).toContain('Bearer [redacted]');
  });

  it('removes key-shaped strings', () => {
    const out = redactSecrets('provider said sk-ant-api03-QQQQWWWWEEEE', []);
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain('[redacted]');
  });

  it('leaves very short secrets alone rather than shredding prose', () => {
    const out = redactSecrets('a key like k was used', ['k']);
    expect(out).toBe('a key like k was used');
  });

  it('never puts the API key into an error message, even when the provider echoes it', async () => {
    const apiKey = 'sk-live-supersecret-value';
    alwaysRespond(401, { error: { message: `bad key: ${apiKey}` } });

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey,
    });

    const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.code).toBe('AUTHENTICATION_ERROR');
    expect(err.message).toContain('Invalid API key');
    expect(err.message).not.toContain(apiKey);
    expect(err.message).toContain('[redacted]');
  });
});

describe('@kindora/llm — HTTP status mapping', () => {
  const cases: Array<{
    status: number;
    code: string;
    message: RegExp;
    retryable: boolean;
  }> = [
    { status: 401, code: 'AUTHENTICATION_ERROR', message: /invalid api key/i, retryable: false },
    { status: 403, code: 'AUTHENTICATION_ERROR', message: /access denied/i, retryable: false },
    { status: 404, code: 'PROVIDER_ERROR', message: /model not found/i, retryable: false },
    { status: 429, code: 'RATE_LIMIT_ERROR', message: /rate limit/i, retryable: true },
    { status: 500, code: 'PROVIDER_ERROR', message: /server error/i, retryable: true },
    { status: 502, code: 'PROVIDER_ERROR', message: /server error/i, retryable: true },
    { status: 503, code: 'PROVIDER_ERROR', message: /server error/i, retryable: true },
    { status: 529, code: 'PROVIDER_ERROR', message: /overloaded/i, retryable: true },
    { status: 400, code: 'PROVIDER_ERROR', message: /request failed/i, retryable: false },
  ];

  for (const c of cases) {
    it(`maps ${c.status} to ${c.code} (retryable: ${c.retryable})`, async () => {
      alwaysRespond(c.status, { error: { message: 'provider said no' } });

      const provider = new OpenAICompatibleProvider({
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        apiKey: 'k',
        sleep: async () => {},
      });

      const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
      expect(err).toBeInstanceOf(LLMError);
      expect(err.code).toBe(c.code);
      expect(err.status).toBe(c.status);
      expect(err.retryable).toBe(c.retryable);
      expect(err.message).toMatch(c.message);
    });
  }
});

describe('@kindora/llm — timeouts and cancellation', () => {
  it('turns a stalled request into TIMEOUT_ERROR', async () => {
    stallForever();

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      timeoutMs: 25,
      sleep: async () => {},
    });

    const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.code).toBe('TIMEOUT_ERROR');
    expect(err.message).toMatch(/timed out/i);
  });

  it('does NOT retry a timeout — the provider may already have billed us', async () => {
    const spy = stallForever();

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      timeoutMs: 25,
      sleep: async () => {},
    });

    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toMatchObject({ code: 'TIMEOUT_ERROR' });
    expect(spy.mock.calls.length).toBe(1);
  });

  it('turns a caller cancellation into ABORTED', async () => {
    stallForever();

    const controller = new AbortController();
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      timeoutMs: 10_000,
      sleep: async () => {},
    });

    const pending = provider.chat(SAMPLE_MESSAGES, { signal: controller.signal });
    controller.abort();

    const err = (await pending.catch((e: unknown) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.code).toBe('ABORTED');
  });

  it('does not even start a request whose signal is already aborted', async () => {
    const spy = alwaysRespond(200, { choices: [{ message: { content: 'ok' } }] });

    const controller = new AbortController();
    controller.abort();

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
    });

    await expect(
      provider.chat(SAMPLE_MESSAGES, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(spy.mock.calls.length).toBe(0);
  });
});

describe('@kindora/llm — invalid responses', () => {
  it('turns a non-JSON body into INVALID_RESPONSE', async () => {
    alwaysRespond(200, '<html>gateway timeout</html>');

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
    });

    const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('turns a JSON body without content into INVALID_RESPONSE', async () => {
    alwaysRespond(200, { choices: [] });

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
    });

    const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
    expect(err.code).toBe('INVALID_RESPONSE');
    expect(err.message).toMatch(/no message content/i);
  });
});

describe('@kindora/llm — bounded retries', () => {
  it('retries a retryable failure up to the limit and then gives up', async () => {
    const spy = alwaysRespond(500, { error: { message: 'boom' } });

    const delays: number[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      sleep: recordingSleep(delays),
    });

    const err = (await provider.chat(SAMPLE_MESSAGES).catch((e: unknown) => e)) as LLMError;
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.status).toBe(500);
    // One attempt plus two retries.
    expect(spy.mock.calls.length).toBe(3);
    // Exponential backoff.
    expect(delays).toEqual([500, 1000]);
  });

  it('never retries a non-retryable failure', async () => {
    const spy = alwaysRespond(401, { error: { message: 'bad key' } });

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      sleep: async () => {},
    });

    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });
    expect(spy.mock.calls.length).toBe(1);
  });

  it('honours Retry-After instead of its own backoff curve', async () => {
    alwaysRespond(429, { error: { message: 'slow down' } }, { 'Retry-After': '2' });

    const delays: number[] = [];
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      sleep: recordingSleep(delays),
    });

    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toMatchObject({
      code: 'RATE_LIMIT_ERROR',
    });
    expect(delays).toEqual([2000, 2000]);
  });

  it('lets a single call lower the retry budget', async () => {
    const spy = alwaysRespond(503, { error: { message: 'boom' } });

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      apiKey: 'k',
      sleep: async () => {},
    });

    await expect(provider.chat(SAMPLE_MESSAGES, { maxRetries: 0 })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(spy.mock.calls.length).toBe(1);
  });
});

describe('@kindora/llm — all providers behave the same way', () => {
  const providers: Array<{ name: string; build: () => LLMProvider }> = [
    {
      name: 'OpenAI-compatible',
      build: () =>
        new OpenAICompatibleProvider({
          baseUrl: 'https://api.example.com/v1',
          model: 'm',
          apiKey: 'k',
          sleep: async () => {},
        }),
    },
    {
      name: 'Anthropic',
      build: () =>
        new AnthropicProvider({
          baseUrl: 'https://api.example.com',
          model: 'claude-sonnet-4-5',
          apiKey: 'k',
          sleep: async () => {},
        }),
    },
    {
      name: 'Ollama',
      build: () =>
        new OllamaProvider({
          baseUrl: 'http://localhost:11434',
          model: 'llama3.1',
          sleep: async () => {},
        }),
    },
  ];

  for (const p of providers) {
    it(`${p.name} maps a network failure to NETWORK_ERROR`, async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
      const err = (await p
        .build()
        .chat(SAMPLE_MESSAGES)
        .catch((e: unknown) => e)) as LLMError;
      expect(err).toBeInstanceOf(LLMError);
      expect(err.code).toBe('NETWORK_ERROR');
    });

    it(`${p.name} maps a 429 to RATE_LIMIT_ERROR`, async () => {
      alwaysRespond(429, { error: { message: 'slow down' } });
      const err = (await p
        .build()
        .chat(SAMPLE_MESSAGES)
        .catch((e: unknown) => e)) as LLMError;
      expect(err).toBeInstanceOf(LLMError);
      expect(err.code).toBe('RATE_LIMIT_ERROR');
      expect(err.retryable).toBe(true);
    });

    it(`${p.name} maps a 500 to a retryable PROVIDER_ERROR`, async () => {
      alwaysRespond(500, { error: { message: 'boom' } });
      const err = (await p
        .build()
        .chat(SAMPLE_MESSAGES)
        .catch((e: unknown) => e)) as LLMError;
      expect(err.code).toBe('PROVIDER_ERROR');
      expect(err.retryable).toBe(true);
    });
  }
});
