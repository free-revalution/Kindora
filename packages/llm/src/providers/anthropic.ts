/**
 * Anthropic Messages API provider.
 *
 * POST {baseUrl}/v1/messages
 * Required headers: x-api-key, anthropic-version, content-type.
 * Note: the system prompt is a top-level field, not a message.
 *
 * See 开发手册.md § 10.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';

export interface AnthropicConfig {
  /** e.g. "https://api.anthropic.com". */
  readonly baseUrl: string;
  /** e.g. "claude-sonnet-4-5". */
  readonly model: string;
  readonly apiKey: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string; type?: string };
}

const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicProvider implements LLMProvider {
  constructor(private readonly config: AnthropicConfig) {}

  async chat(messages: readonly ChatMessage[], options: LLMOptions = {}): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const conversation: AnthropicMessage[] = messages
      .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    if (conversation.length === 0) {
      throw new Error('Anthropic requires at least one user/assistant message.');
    }

    const url = joinUrl(this.config.baseUrl, 'v1/messages');
    const body = {
      model: this.config.model,
      messages: conversation,
      ...(systemMessage ? { system: systemMessage.content } : {}),
      max_tokens: options.maxTokens ?? 1024,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.stop ? { stop_sequences: [...options.stop] } : {}),
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    const payload = (await res.json().catch(() => ({}))) as AnthropicResponse;

    if (!res.ok) {
      throw mapHttpError(res.status, payload?.error?.message ?? res.statusText);
    }

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' || block.text !== undefined)
      .map((block) => block.text ?? '')
      .join('');

    if (!text) {
      throw new Error('Anthropic response had no text content.');
    }

    return Object.freeze({
      content: text,
      model: payload.model ?? this.config.model,
      usage: payload.usage
        ? Object.freeze({
            promptTokens: payload.usage.input_tokens,
            completionTokens: payload.usage.output_tokens,
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
  if (status === 529) return new Error(`Anthropic overloaded (529): ${fallbackMessage}`);
  if (status >= 500) return new Error(`Server error (${status}): ${fallbackMessage}`);
  return new Error(`LLM request failed (${status}): ${fallbackMessage}`);
}
