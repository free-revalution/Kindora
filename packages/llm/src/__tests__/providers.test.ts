import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createProvider,
  OpenAICompatibleProvider,
  AnthropicProvider,
  OllamaProvider,
  type ChatMessage,
} from '../index';

const SAMPLE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello.' },
];

function mockFetchOnce(response: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(response), {
      status,
      statusText: ok ? 'OK' : 'Server Error',
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('@kindora/llm — OpenAICompatibleProvider', () => {
  it('POSTs to {baseUrl}/chat/completions with Bearer auth', async () => {
    const spy = mockFetchOnce({
      choices: [{ message: { role: 'assistant', content: 'Hi!' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });

    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      apiKey: 'sk-test',
    });
    const res = await provider.chat(SAMPLE_MESSAGES);

    expect(res.content).toBe('Hi!');
    expect(res.model).toBe('gpt-4o-mini');
    expect(res.usage?.totalTokens).toBe(8);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello.' },
    ]);
    expect(body.stream).toBe(false);
  });

  it('does not set Authorization when API key is missing (e.g. local proxy)', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'ok' } }] });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
    });
    await provider.chat(SAMPLE_MESSAGES);
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('throws Invalid-API-key on 401', async () => {
    mockFetchOnce({ error: { message: 'bad key' } }, { ok: false, status: 401 });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'x',
      apiKey: 'bad',
    });
    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toThrow(/invalid api key/i);
  });

  it('throws Model-not-found on 404', async () => {
    mockFetchOnce({ error: { message: 'no such model' } }, { ok: false, status: 404 });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'missing',
      apiKey: 'k',
    });
    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toThrow(/model not found/i);
  });

  it('throws Rate-limit on 429', async () => {
    mockFetchOnce({ error: { message: 'slow down' } }, { ok: false, status: 429 });
    const provider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.com/v1',
      model: 'x',
      apiKey: 'k',
    });
    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toThrow(/rate limit/i);
  });
});

describe('@kindora/llm — AnthropicProvider', () => {
  it('POSTs to {baseUrl}/v1/messages with x-api-key + anthropic-version', async () => {
    const spy = mockFetchOnce({
      content: [{ type: 'text', text: 'Bonjour' }],
      model: 'claude-sonnet-4-5',
      usage: { input_tokens: 4, output_tokens: 1 },
    });

    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-test',
    });
    const res = await provider.chat(SAMPLE_MESSAGES);

    expect(res.content).toBe('Bonjour');
    expect(res.model).toBe('claude-sonnet-4-5');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');

    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('You are a helpful assistant.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello.' }]);
    expect(typeof body.max_tokens).toBe('number');
  });

  it('refuses to call with only a system message', async () => {
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    });
    await expect(provider.chat([{ role: 'system', content: 'no user' }])).rejects.toThrow(
      /at least one user\/assistant/i,
    );
  });

  it('maps 529 to overloaded error', async () => {
    mockFetchOnce({ error: { message: 'overloaded' } }, { ok: false, status: 529 });
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      apiKey: 'k',
    });
    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toThrow(/overloaded/i);
  });
});

describe('@kindora/llm — OllamaProvider', () => {
  it('POSTs to {baseUrl}/api/chat with no auth headers', async () => {
    const spy = mockFetchOnce({
      message: { role: 'assistant', content: 'Greetings from llama' },
      done: true,
    });

    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      model: 'llama3.1',
    });
    const res = await provider.chat(SAMPLE_MESSAGES);

    expect(res.content).toBe('Greetings from llama');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['x-api-key']).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('llama3.1');
  });

  it('throws Model-not-found on 404', async () => {
    mockFetchOnce({ error: 'model X not found' }, { ok: false, status: 404 });
    const provider = new OllamaProvider({
      baseUrl: 'http://localhost:11434',
      model: 'missing',
    });
    await expect(provider.chat(SAMPLE_MESSAGES)).rejects.toThrow(/model not found/i);
  });
});

describe('@kindora/llm — createProvider factory', () => {
  it('builds an OpenAI-compatible provider by default baseUrl', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'ok' } }] });
    const provider = createProvider({
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'sk-ds',
    });
    await provider.chat(SAMPLE_MESSAGES);
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('builds an Anthropic provider with default baseUrl', async () => {
    mockFetchOnce({ content: [{ type: 'text', text: 'ok' }] });
    const provider = createProvider({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant',
    });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('builds an Ollama provider with default baseUrl', async () => {
    mockFetchOnce({ message: { content: 'ok' }, done: true });
    const provider = createProvider({
      provider: 'ollama',
      model: 'llama3.1',
    });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('http://localhost:11434/api/chat');
  });

  it('throws when OpenAI-compatible is missing baseUrl', () => {
    expect(() =>
      createProvider({ provider: 'openai-compatible', model: 'x', apiKey: 'k' }),
    ).toThrow(/baseUrl/i);
  });

  it('throws when Anthropic is missing API key', () => {
    expect(() => createProvider({ provider: 'anthropic', model: 'claude-sonnet-4-5' })).toThrow(
      /api key/i,
    );
  });

  it('builds a MiniMax provider with the official baseUrl and Bearer auth', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'ok' } }] });
    const provider = createProvider({
      provider: 'minimax',
      model: 'MiniMax-M3',
      apiKey: 'mm-test-key',
    });
    await provider.chat(SAMPLE_MESSAGES);
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.minimaxi.com/v1/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer mm-test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('MiniMax-M3');
    expect(body.stream).toBe(false);
  });

  it('MiniMax honors a user-supplied baseUrl override', async () => {
    mockFetchOnce({ choices: [{ message: { content: 'ok' } }] });
    const provider = createProvider({
      provider: 'minimax',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'MiniMax-M3',
      apiKey: 'mm-test-key',
    });
    await provider.chat(SAMPLE_MESSAGES);
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
    ];
    expect(url).toBe('https://proxy.example.com/v1/chat/completions');
  });

  it('throws when MiniMax is missing an API key', () => {
    expect(() => createProvider({ provider: 'minimax', model: 'MiniMax-M3' })).toThrow(/api key/i);
  });
});
