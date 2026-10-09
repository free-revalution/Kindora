/**
 * analyze-match — the public Phase 3 entry point.
 *
 *   1. Build a bounded ChatMessage[] (system + user) from the two
 *      profiles, with a token budget enforced by `buildMatchContext`.
 *   2. Call the injected LLM provider.
 *   3. Parse the response into a `MatchAnalysis`, applying the
 *      boundary override (both-sides-disallow → signal 'none').
 *
 * The caller (desktop / tests) owns the LLM provider and the runtime
 * config. This module is pure orchestration on top of those.
 *
 * See 开发手册.md § 35, § 51, Phase 3.
 */
import type { ChatMessage, LLMOptions, LLMProvider } from '@kindora/llm';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import { type BuildContextOptions, buildMatchContext } from './context-builder';
import { computeHeuristics } from './heuristics';
import { applyBoundaryOverride, parseMatchAnalysis, type ParseResult } from './output-parser';

/** Minimal config shape required by analyze-match — keeps the import surface small. */
export interface AnalyzeMatchConfig {
  readonly maxMatchTokens: number;
}

export interface AnalyzeMatchInput {
  readonly selfProfile: SocialProfile;
  readonly selfDisplayName?: string;
  readonly peerProfile: SocialProfile;
  readonly peerDisplayName?: string;
}

export interface AnalyzeMatchOptions {
  /** Overrides the default token budget for the system+user prompt. */
  readonly tokenBudget?: number;
  /** Forwarded to `LLMProvider.chat`. */
  readonly llm?: LLMOptions;
}

export interface AnalyzeMatchResult {
  readonly analysis: MatchAnalysis;
  /** Messages actually sent to the LLM — handy for logging / tests. */
  readonly messages: readonly ChatMessage[];
  /** Tokens consumed (best-effort estimate; 0 chars → 0 tokens). */
  readonly estimatedTokens: number;
  /** Raw model reply, kept for debugging — never contains secrets. */
  readonly rawResponse: string;
  /** True iff the parser had to fall back to defaults. */
  readonly degraded: boolean;
  /** Reason for degradation, if any. */
  readonly degradationNote: string | null;
}

export async function analyzeMatch(
  provider: LLMProvider,
  input: AnalyzeMatchInput,
  config: AnalyzeMatchConfig = { maxMatchTokens: 2000 },
  options: AnalyzeMatchOptions = {},
): Promise<AnalyzeMatchResult> {
  const contextOptions: BuildContextOptions = {
    maxTokens: options.tokenBudget ?? config.maxMatchTokens,
  };

  // Pre-check the heuristic blocking list — if both sides disable
  // agent conversation, we can short-circuit before even hitting the
  // LLM and save tokens / latency / cost.
  const hints = computeHeuristics(input.selfProfile, input.peerProfile);
  if (hints.blockingIssues.length > 0) {
    const messages = buildMatchContext(input, contextOptions);
    const tokens = estimateTotal(messages);
    const blocked = applyBoundaryOverride(
      // any signal — the override will reduce it to 'none'
      {
        compatibilitySignal: 'strong',
        commonGround: [],
        recommendedTopics: [],
        potentialFriction: [],
        explanation: '',
      },
      input.selfProfile,
      input.peerProfile,
    );
    return {
      analysis: blocked,
      messages,
      estimatedTokens: tokens,
      rawResponse: '',
      degraded: true,
      degradationNote: 'boundary-block: ' + hints.blockingIssues.join('; '),
    };
  }

  const messages = buildMatchContext(input, contextOptions);
  const tokens = estimateTotal(messages);

  const llmOptions: LLMOptions = {
    temperature: options.llm?.temperature ?? 0.2,
    maxTokens: options.llm?.maxTokens ?? 600,
    signal: options.llm?.signal,
    stop: options.llm?.stop,
  };

  const response = await provider.chat(messages, llmOptions);
  const parsed: ParseResult = parseMatchAnalysis(response.content);
  const analysis = applyBoundaryOverride(parsed.analysis, input.selfProfile, input.peerProfile);

  return {
    analysis,
    messages,
    estimatedTokens: tokens,
    rawResponse: response.content,
    degraded: parsed.degraded,
    degradationNote: parsed.note,
  };
}

function estimateTotal(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += Math.ceil(m.content.length / 4);
  return total;
}
