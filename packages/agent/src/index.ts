/**
 * @kindora/agent
 *
 * Agent runtime + identity + profile validation.
 * Phase 1: types, helpers, and identity generation.
 * LLM wiring lands in Phase 3.
 *
 * See 开发手册.md § 13, § 52.
 */

export const AGENT_RUNTIME_VERSION = '0.1.0';

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

export { type AgentIdentity, createAgentIdentity, buildCapabilities } from './identity';
export {
  type ProfileValidationError,
  type ProfileLimits,
  DEFAULT_PROFILE_LIMITS,
  validateProfile,
  isProfileValid,
} from './profile';
