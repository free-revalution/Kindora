/**
 * Ollama chat provider.
 *
 * Local model server — no API key. POST {baseUrl}/api/chat with
 * { model, messages, stream: false }.
 *
 * The transport is shared with every other provider (`../http`): one error
 * model, one timeout policy, one cancellation rule, one retry policy.
 *
 * See 开发手册.md § 10 and `docs/修复.md` § 八 E1.
 */

import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '../index';
import { LLMError } from '../errors';
import { sendJson, resolvePolicy, type LLMRequestOptions } from '../http';

export interface OllamaConfig extends LLMRequestOptions {
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

    const policy = resolvePolicy(this.config, {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });

    const { payload } = await sendJson<OllamaChatResponse>(
      {
        url,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal,
      },
      policy,
    );

    const content = payload.message?.content ?? '';
    if (!content) {
      throw new LLMError('INVALID_RESPONSE', 'Ollama response had no message content.');
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
