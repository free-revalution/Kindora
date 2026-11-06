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
 * Phase E1: every provider now shares one error model, one timeout policy,
 * one cancellation rule and one retry policy (`./http`), and throws
 * `LLMError` (`./errors`) for every failure.
 *
 * See 开发手册.md § 10–11 and `docs/修复.md` § 八.
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
  /** Deadline for this call, in milliseconds. Overrides the provider default. */
  timeoutMs?: number;
  /** Extra attempts after a retryable failure. Overrides the provider default. */
  maxRetries?: number;
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
  /** Deadline for one attempt, in milliseconds. Default 60000. */
  readonly timeoutMs?: number;
  /** Extra attempts after a retryable failure. Default 2. */
  readonly maxRetries?: number;
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
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
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
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
    }
    case 'ollama': {
      const baseUrl = config.baseUrl ?? 'http://localhost:11434';
      return new OllamaProvider({
        baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
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
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* The unified error model + transport policy (Phase E1)               */
/* ------------------------------------------------------------------ */

export {
  LLMError,
  isLLMError,
  redactSecrets,
  type LLMErrorCode,
  type LLMErrorInit,
} from './errors';

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_POLICY,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  resolvePolicy,
  sendJson,
  type JsonRequest,
  type JsonResponse,
  type LLMRequestOptions,
  type RequestPolicy,
} from './http';
