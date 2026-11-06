/**
 * Anthropic Messages API provider.
 *
 * POST {baseUrl}/v1/messages
 * Required headers: x-api-key, anthropic-version, content-type.
 * Note: the system prompt is a top-level field, not a message.
 *
 * The transport is shared with every other provider (`../http`): one error
 * model, one timeout policy, one cancellation rule, one retry policy.
 *
 * See 开发手册.md § 10 and `docs/修复.md` § 八 E1.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';
import { LLMError } from '../errors';
import { sendJson, resolvePolicy, type LLMRequestOptions } from '../http';

export interface AnthropicConfig extends LLMRequestOptions {
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
      throw new LLMError(
        'PROVIDER_ERROR',
        'Anthropic requires at least one user/assistant message.',
      );
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

    const policy = resolvePolicy(this.config, {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });

    const { payload } = await sendJson<AnthropicResponse>(
      {
        url,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: options.signal,
        secrets: [this.config.apiKey],
      },
      policy,
    );

    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text' || block.text !== undefined)
      .map((block) => block.text ?? '')
      .join('');

    if (!text) {
      throw new LLMError('INVALID_RESPONSE', 'Anthropic response had no text content.');
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
