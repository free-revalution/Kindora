/**
 * OpenAI-compatible chat provider.
 *
 * Covers OpenAI, DeepSeek, Qwen, Doubao, and any provider that follows
 * the OpenAI Chat Completions shape.
 *
 * See 开发手册.md § 10.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';

export interface OpenAICompatibleConfig {
  /** e.g. "https://api.openai.com/v1" */
  readonly baseUrl: string;
  /** e.g. "gpt-4o-mini", "deepseek-chat", "qwen-turbo". */
  readonly model: string;
  /** API key is required for hosted providers; not used by Ollama. */
  readonly apiKey?: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  async chat(messages: readonly ChatMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const url = joinUrl(this.config.baseUrl, 'chat/completions');
    const body = {
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      ...(options.stop ? { stop: [...options.stop] } : {}),
      stream: false,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });

    const payload = (await res.json().catch(() => ({}))) as OpenAIChatResponse;

    if (!res.ok) {
      throw mapHttpError(res.status, payload?.error?.message ?? res.statusText);
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!content) {
      throw new Error('OpenAI-compatible response had no message content.');
    }

    return Object.freeze({
      content,
      model: this.config.model,
      usage: payload.usage
        ? Object.freeze({
            promptTokens: payload.usage.prompt_tokens,
            completionTokens: payload.usage.completion_tokens,
            totalTokens: payload.usage.total_tokens,
          })
        : undefined,
    });
  }
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/${path.replace(/^\/+/, '')}`;
}

function mapHttpError(status: number, fallbackMessage: string): Error {
  if (status === 401) return new Error(`Invalid API key (401): ${fallbackMessage}`);
  if (status === 404)
    return new Error(`Model not found or wrong base URL (404): ${fallbackMessage}`);
  if (status === 429) return new Error(`Rate limit exceeded (429): ${fallbackMessage}`);
  if (status >= 500) return new Error(`Server error (${status}): ${fallbackMessage}`);
  return new Error(`LLM request failed (${status}): ${fallbackMessage}`);
}
