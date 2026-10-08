/**
 * @kindora/agent
 *
 * Agent runtime. Wraps the user's LLM with:
 *   - a hardened system prompt (treats remote content as untrusted input)
 *   - a bounded conversation window (default 6 messages)
 *   - token-limit guards
 *
 * Phase 0: type-level skeleton only. No LLM calls yet — see Phase 3.
 */

/**
 * Hard cap on the number of agent-to-agent messages exchanged
 * per match attempt. Configurable via runtime options.
 *
 * See 开发手册.md § 52.
 */
export const DEFAULT_MAX_AGENT_MESSAGES = 6;

export interface AgentRuntimeOptions {
  maxAgentMessages?: number;
  maxMatchTokens?: number;
  maxIcebreakerTokens?: number;
}

export interface AgentRuntimeConfig {
  readonly maxAgentMessages: number;
  readonly maxMatchTokens: number;
  readonly maxIcebreakerTokens: number;
}

export function createAgentConfig(opts: AgentRuntimeOptions = {}): AgentRuntimeConfig {
  return Object.freeze({
    maxAgentMessages: opts.maxAgentMessages ?? DEFAULT_MAX_AGENT_MESSAGES,
    maxMatchTokens: opts.maxMatchTokens ?? 2000,
    maxIcebreakerTokens: opts.maxIcebreakerTokens ?? 500,
  });
}

export const AGENT_RUNTIME_VERSION = '0.1.0';
