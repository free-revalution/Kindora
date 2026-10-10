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
    // The icebreaker context carries system prompt + self profile + peer
    // profile + heuristics + match report + topic hints. 1000 tokens
    // (~4000 chars) is the smallest budget that fits comfortably without
    // truncation for both thin and rich profile pairs.
    maxIcebreakerTokens: opts.maxIcebreakerTokens ?? 1000,
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
export { MATCH_ANALYST_SYSTEM_PROMPT, ICEBREAKER_SYSTEM_PROMPT } from './system-prompt';
export { renderProfileContext, type ProfileContextOptions } from './profile-context';
export { computeHeuristics, renderHeuristics, type HeuristicHints } from './heuristics';
export {
  buildMatchContext,
  renderMatchUserMessage,
  buildIcebreakerContext,
  renderIcebreakerUserMessage,
  estimateTokens,
  DEFAULT_CHARS_PER_TOKEN,
  TokenLimitExceeded,
  type BuildContextInput,
  type BuildContextOptions,
  type BuildIcebreakerInput,
  type BuildIcebreakerContextOptions,
} from './context-builder';
export {
  parseMatchAnalysis,
  parseIcebreakerTopics,
  coerceIcebreakerTopics,
  extractJsonObject,
  applyBoundaryOverride,
  MAX_ICEBREAKER_TOPICS,
  type ParseResult,
  type ParseIcebreakerResult,
} from './output-parser';
export {
  analyzeMatch,
  type AnalyzeMatchInput,
  type AnalyzeMatchOptions,
  type AnalyzeMatchResult,
} from './analyze-match';
export {
  generateIcebreaker,
  ICEBREAKER_TOPIC_CAP,
  type GenerateIcebreakerInput,
  type GenerateIcebreakerOptions,
  type GenerateIcebreakerConfig,
  type GenerateIcebreakerResult,
} from './generate-icebreaker';
