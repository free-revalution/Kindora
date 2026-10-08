/**
 * Ollama chat provider.
 *
 * Local model server — no API key. POST {baseUrl}/api/chat with
 * { model, messages, stream: false }.
 *
 * See 开发手册.md § 10.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';

export interface OllamaConfig {
  /** e.g. "http://localhost:11434". */
  readonly baseUrl: string;
  /** e.g. "llama3.1". */
  readonly model: string;
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  constructor(private readonly config: OllamaConfig) {}

  async chat(messages: readonly ChatMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const url = joinUrl(this.config.baseUrl, 'api/chat');
    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      ...(options.temperature !== undefined
        ? { options: { temperature: options.temperature } }
        : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    const payload = (await res.json().catch(() => ({}))) as OllamaChatResponse;

    if (!res.ok) {
      throw mapHttpError(res.status, payload?.error ?? res.statusText);
    }

    const content = payload.message?.content ?? '';
    if (!content) {
      throw new Error('Ollama response had no message content.');
    }

    return Object.freeze({
      content,
      model: this.config.model,
    });
  }
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${path.replace(/^\/+/, '')}`;
}

function mapHttpError(status: number, fallbackMessage: string): Error {
  if (status === 404) return new Error(`Model not found (404): ${fallbackMessage}`);
  if (status >= 500) return new Error(`Ollama server error (${status}): ${fallbackMessage}`);
  return new Error(`Ollama request failed (${status}): ${fallbackMessage}`);
}
