/**
 * @kindora/llm
 *
 * Unified LLM provider interface.
 * Phase 0: types only — concrete adapters land in Phase 2.
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

export type LLMProviderKind = 'openai-compatible' | 'anthropic' | 'ollama';

export interface LLMConfig {
  readonly provider: LLMProviderKind;
  readonly baseUrl?: string;
  readonly model: string;
  /** API key is required for cloud providers; stored only in OS keychain. */
  readonly apiKey?: string;
}

export const LLM_PACKAGE_VERSION = '0.1.0';
