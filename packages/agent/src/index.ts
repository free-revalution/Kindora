/**
 * @kindora/agent
 *
 * Agent runtime — system prompt, context builder, bounded LLM call,
 * output parser, and the public `analyzeMatch` orchestrator.
 *
 * Phase 1: types, helpers, identity generation.
 * Phase 3: runtime that turns a (self, peer) profile pair into a
 *          `MatchAnalysis` via the user's own LLM provider.
 *
 * No tools, no network beyond the LLM call. See 开发手册.md § 35–36.
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

/* Phase 3 — Agent Runtime */
export { MATCH_ANALYST_SYSTEM_PROMPT } from './system-prompt';
export { renderProfileContext, type ProfileContextOptions } from './profile-context';
export { computeHeuristics, renderHeuristics, type HeuristicHints } from './heuristics';
export {
  buildMatchContext,
  renderMatchUserMessage,
  estimateTokens,
  DEFAULT_CHARS_PER_TOKEN,
  TokenLimitExceeded,
  type BuildContextInput,
  type BuildContextOptions,
} from './context-builder';
export {
  parseMatchAnalysis,
  extractJsonObject,
  applyBoundaryOverride,
  type ParseResult,
} from './output-parser';
export {
  analyzeMatch,
  type AnalyzeMatchInput,
  type AnalyzeMatchOptions,
  type AnalyzeMatchResult,
} from './analyze-match';
