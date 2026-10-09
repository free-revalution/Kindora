/**
 * @kindora/llm
 *
 * Unified LLM provider interface + adapters.
 * Phase 2: OpenAI-compatible, Anthropic, Ollama, MiniMax.
 *
 * MiniMax (https://api.minimaxi.com) ships an OpenAI-compatible
 * /v1/chat/completions endpoint, so we route it through the
 * OpenAI-compatible adapter. It gets its own `provider` kind so the
 * desktop Settings UI can offer a first-class preset (default baseUrl,
 * example models) instead of a generic "custom" entry.
 *
 * See 开发手册.md § 10–11.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: readonly string[];
  signal?: AbortSignal;
}

export interface LLMResponse {
  readonly content: string;
  readonly model: string;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface LLMProvider {
  chat(messages: readonly ChatMessage[], options?: LLMOptions): Promise<LLMResponse>;
}

export type LLMProviderKind = 'openai-compatible' | 'anthropic' | 'ollama' | 'minimax';

export interface LLMConfig {
  readonly provider: LLMProviderKind;
  readonly baseUrl?: string;
  readonly model: string;
  /** API key is required for cloud providers; stored only in SecretStore. */
  readonly apiKey?: string;
}

export const LLM_PACKAGE_VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* Provider factory                                                    */
/* ------------------------------------------------------------------ */

import { AnthropicProvider } from './providers/anthropic';
import { OllamaProvider } from './providers/ollama';
import { OpenAICompatibleProvider } from './providers/openai-compatible';

export { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider };

/**
 * Build a provider from a `LLMConfig` + API key (looked up from the
 * SecretStore by the caller).
 */
export function createProvider(config: LLMConfig): LLMProvider {
  switch (config.provider) {
    case 'openai-compatible': {
      const baseUrl = config.baseUrl ?? '';
      if (!baseUrl) {
        throw new Error('OpenAI-compatible provider requires a baseUrl.');
      }
      return new OpenAICompatibleProvider({
        baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      });
    }
    case 'anthropic': {
      const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
      if (!config.apiKey) {
        throw new Error('Anthropic provider requires an API key.');
      }
      return new AnthropicProvider({
        baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      });
    }
    case 'ollama': {
      const baseUrl = config.baseUrl ?? 'http://localhost:11434';
      return new OllamaProvider({ baseUrl, model: config.model });
    }
    case 'minimax': {
      const baseUrl = config.baseUrl ?? 'https://api.minimaxi.com/v1';
      if (!config.apiKey) {
        throw new Error('MiniMax provider requires an API key.');
      }
      return new OpenAICompatibleProvider({
        baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      });
    }
  }
}
