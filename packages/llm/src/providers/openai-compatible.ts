/**
 * OpenAI-compatible chat provider.
 *
 * Covers OpenAI, DeepSeek, Qwen, Doubao, MiniMax, and any provider that
 * follows the OpenAI Chat Completions shape.
 *
 * The transport is shared with every other provider (`../http`): one error
 * model, one timeout policy, one cancellation rule, one retry policy.
 *
 * See 开发手册.md § 10 and `docs/修复.md` § 八 E1.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';
import { LLMError } from '../errors';
import { sendJson, resolvePolicy, type LLMRequestOptions } from '../http';

export interface OpenAICompatibleConfig extends LLMRequestOptions {
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

    const policy = resolvePolicy(this.config, {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });

    const { payload } = await sendJson<OpenAIChatResponse>(
      {
        url,
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
        secrets: [this.config.apiKey],
      },
      policy,
    );

    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (!content) {
      throw new LLMError('INVALID_RESPONSE', 'OpenAI-compatible response had no message content.');
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
