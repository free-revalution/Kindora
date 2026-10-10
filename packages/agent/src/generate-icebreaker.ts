/**
 * generate-icebreaker — the public Phase 8 entry point.
 *
 *   1. Boundary pre-check — if both sides disallow agent conversation,
 *      short-circuit to an empty topics list (no LLM call, no cost,
 *      no risk of leaking profile data to a model we don't need).
 *   2. Build a bounded ChatMessage[] (system + user) from the two
 *      profiles + the match analyst's report + optional peer hints.
 *   3. Call the injected LLM provider.
 *   4. Parse the response into up to 3 concrete conversation starters.
 *
 * The caller owns the LLM provider and the runtime config. This module
 * is pure orchestration on top of those.
 *
 * Per § 29: the AI only SUGGESTS; the human reviews before sending.
 * Therefore this function NEVER auto-sends anything. It only returns
 * candidate starters for the user to pick from (Use / Edit /
 * Regenerate).
 *
 * See 开发手册.md § 28, § 29, Phase 8.
 */
import type { ChatMessage, LLMOptions, LLMProvider } from '@kindora/llm';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import {
  buildIcebreakerContext,
  type BuildIcebreakerContextOptions,
} from './context-builder';
import { computeHeuristics } from './heuristics';
import { MAX_ICEBREAKER_TOPICS, parseIcebreakerTopics, type ParseIcebreakerResult } from './output-parser';

export interface GenerateIcebreakerConfig {
  readonly maxIcebreakerTokens: number;
}

export interface GenerateIcebreakerInput {
  readonly selfProfile: SocialProfile;
  readonly selfDisplayName?: string;
  readonly peerProfile: SocialProfile;
  readonly peerDisplayName?: string;
  /**
   * Optional analysis from `analyzeMatch`. When present, its
   * `commonGround` / `recommendedTopics` ground the generated
   * starters more concretely.
   */
  readonly analysis?: MatchAnalysis | null;
  /**
   * Optional hints from the peer (e.g. via an `icebreaker_request`
   * envelope). Treated as UNTRUSTED data — forwarded into the prompt
   * but never followed as instructions.
   */
  readonly topicHints?: readonly string[];
}

export interface GenerateIcebreakerOptions {
  /** Overrides the default token budget for the system+user prompt. */
  readonly tokenBudget?: number;
  /** Forwarded to `LLMProvider.chat`. */
  readonly llm?: LLMOptions;
}

export interface GenerateIcebreakerResult {
  /**
   * Up to MAX_ICEBREAKER_TOPICS starter strings in the LOCAL user's
   * voice. Empty when generation failed AND we cannot safely retry —
   * the UI shows a "Try again" button (Regenerate) for everything else.
   */
  readonly topics: readonly string[];
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
  /**
   * True iff we short-circuited BEFORE calling the LLM (boundary
   * block). When true, `topics` is empty and the caller should not
   * offer Regenerate — the boundary is permanent.
   */
  readonly boundaryBlocked: boolean;
}

/**
 * Generate up to 3 icebreaker conversation starters for the local user.
 *
 * The function is idempotent and side-effect free — call it again to
 * "Regenerate". It never auto-sends.
 */
export async function generateIcebreaker(
  provider: LLMProvider,
  input: GenerateIcebreakerInput,
  config: GenerateIcebreakerConfig = { maxIcebreakerTokens: 1000 },
  options: GenerateIcebreakerOptions = {},
): Promise<GenerateIcebreakerResult> {
  const contextOptions: BuildIcebreakerContextOptions = {
    maxTokens: options.tokenBudget ?? config.maxIcebreakerTokens,
  };

  // Boundary short-circuit (§ 35): if both sides disable agent
  // conversation, no icebreaker is possible. We surface an empty list
  // without paying for an LLM call.
  const hints = computeHeuristics(input.selfProfile, input.peerProfile);
  if (hints.blockingIssues.length > 0) {
    const messages = buildIcebreakerContext(input, contextOptions);
    const tokens = estimateTotal(messages);
    return {
      topics: Object.freeze([]),
      messages,
      estimatedTokens: tokens,
      rawResponse: '',
      degraded: true,
      degradationNote: 'boundary-block: ' + hints.blockingIssues.join('; '),
      boundaryBlocked: true,
    };
  }

  // Thin-profile guard: if both profiles are essentially empty, the
  // model has nothing to ground starters in. Refuse gracefully rather
  // than letting it hallucinate generic openers.
  if (isThinProfile(input.selfProfile) && isThinProfile(input.peerProfile)) {
    const messages = buildIcebreakerContext(input, contextOptions);
    const tokens = estimateTotal(messages);
    return {
      topics: Object.freeze([]),
      messages,
      estimatedTokens: tokens,
      rawResponse: '',
      degraded: true,
      degradationNote: 'thin-profile: not enough profile data to ground icebreakers',
      boundaryBlocked: false,
    };
  }

  const messages = buildIcebreakerContext(input, contextOptions);
  const tokens = estimateTotal(messages);

  const llmOptions: LLMOptions = {
    temperature: options.llm?.temperature ?? 0.7,
    maxTokens: options.llm?.maxTokens ?? 240,
    signal: options.llm?.signal,
    stop: options.llm?.stop,
  };

  const response = await provider.chat(messages, llmOptions);
  const parsed: ParseIcebreakerResult = parseIcebreakerTopics(response.content);

  return {
    topics: parsed.topics,
    messages,
    estimatedTokens: tokens,
    rawResponse: response.content,
    degraded: parsed.degraded,
    degradationNote: parsed.note,
    boundaryBlocked: false,
  };
}

function estimateTotal(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += Math.ceil(m.content.length / 4);
  return total;
}

/**
 * A profile is "thin" when it carries nothing the model can ground a
 * starter in — empty bio, no interests, no activities, no intents.
 * Social-Intent alone isn't enough because it doesn't say what to talk
 * ABOUT.
 */
function isThinProfile(p: SocialProfile): boolean {
  const bioEmpty = !p.bio || p.bio.trim().length === 0;
  const noInterests = !p.interests || p.interests.length === 0;
  const noActivities = !p.currentActivities || p.currentActivities.length === 0;
  return bioEmpty && noInterests && noActivities;
}

/**
 * Convenience constant — exported so the UI can render a placeholder
 * "We'll generate 3" copy and the tests can assert the cap.
 */
export const ICEBREAKER_TOPIC_CAP = MAX_ICEBREAKER_TOPICS;