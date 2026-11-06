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
  maxChatAssistTokens?: number;
}

export interface AgentRuntimeConfig {
  readonly maxAgentMessages: number;
  readonly maxMatchTokens: number;
  readonly maxIcebreakerTokens: number;
  readonly maxChatAssistTokens: number;
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
    // The chat-assist context carries system prompt + both profiles +
    // heuristics + match report + recent chat history + the user's
    // free-text query. 1200 tokens (~4800 chars) is the smallest budget
    // that fits the system prompt + a dozen history entries without
    // truncation for both rich and thin profile pairs.
    maxChatAssistTokens: opts.maxChatAssistTokens ?? 1200,
  });
}

export {
  type AgentIdentity,
  type RuntimeCapabilities,
  type CapabilityOverrides,
  createAgentIdentity,
  buildCapabilities,
  buildRuntimeCapabilities,
} from './identity';
/**
 * Phase A / A2 — the envelope signer.
 *
 * The transport layer never sees a private key; it only knows the
 * `EnvelopeSigner` interface from `@kindora/protocol`. Keeping the
 * bridge here means the OS keychain (where the key actually lives in
 * the shipped desktop app) stays out of `@kindora/transport`.
 */
export { createEnvelopeSigner, type SignerIdentity } from './signer';
export {
  type ProfileValidationError,
  type ProfileValidationCode,
  type ProfileLimits,
  DEFAULT_PROFILE_LIMITS,
  validateProfile,
  isProfileValid,
} from './profile';

/* Phase 3 — Agent Runtime */
export {
  MATCH_ANALYST_SYSTEM_PROMPT,
  ICEBREAKER_SYSTEM_PROMPT,
  CHAT_ASSIST_SYSTEM_PROMPT,
} from './system-prompt';
export { renderProfileContext, type ProfileContextOptions } from './profile-context';
export { computeHeuristics, renderHeuristics, type HeuristicHints } from './heuristics';
export {
  buildMatchContext,
  buildMatchContextDetailed,
  renderMatchUserMessage,
  renderMatchUserMessageDetailed,
  buildIcebreakerContext,
  buildIcebreakerContextDetailed,
  renderIcebreakerUserMessage,
  renderIcebreakerUserMessageDetailed,
  buildChatAssistContext,
  buildChatAssistContextDetailed,
  renderChatAssistUserMessage,
  renderChatAssistUserMessageDetailed,
  estimateTokens,
  DEFAULT_CHARS_PER_TOKEN,
  TokenLimitExceeded,
  type BuildContextInput,
  type BuildContextOptions,
  type BuildContextResult,
  type BuildIcebreakerInput,
  type BuildIcebreakerContextOptions,
  type BuildChatAssistInput,
  type BuildChatAssistContextOptions,
  type ChatHistoryEntryLike,
  type RenderedUserMessage,
  type UntrustedNotice,
  type UntrustedSource,
} from './context-builder';
export {
  parseMatchAnalysis,
  parseIcebreakerTopics,
  parseChatAssistReply,
  coerceIcebreakerTopics,
  extractJsonObject,
  applyBoundaryOverride,
  MAX_ICEBREAKER_TOPICS,
  MAX_CHAT_ASSIST_SUGGESTIONS,
  CHAT_ASSIST_KINDS,
  type ParseResult,
  type ParseIcebreakerResult,
  type ParseChatAssistResult,
  type ChatAssistKind,
  type ChatAssistSuggestion,
  type ChatAssistReply,
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
export {
  generateChatAssist,
  type GenerateChatAssistInput,
  type GenerateChatAssistOptions,
  type GenerateChatAssistConfig,
  type GenerateChatAssistResult,
} from './generate-chat-assist';
