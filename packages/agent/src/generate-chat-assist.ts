/**
 * generate-chat-assist — the public Phase 10 entry point.
 *
 *   1. Boundary pre-check — if both sides disallow agent conversation,
 *      short-circuit to an empty reply (no LLM call, no cost, no risk
 *      of leaking profile data to a model we don't need).
 *   2. Build a bounded ChatMessage[] (system + user) from the user's
 *      free-text query, the live chat history, and the two profiles +
 *      optional match analysis.
 *   3. Call the injected LLM provider.
 *   4. Parse the response into up to 4 `ChatAssistSuggestion`s.
 *
 * Per § 32: the AI only SUGGESTS — the human reviews before any of it
 * ever hits the wire. Therefore this function NEVER auto-sends
 * anything. It only returns candidate suggestions for the user to
 * Use / Edit / Regenerate / Dismiss.
 *
 * The caller owns the LLM provider and the runtime config. The
 * `history` field is read fresh from the live ChatOrchestrator
 * snapshot at the moment of the call, so the model always sees the
 * freshest transcript.
 *
 * See 开发手册.md § 31, § 32, Phase 10.
 */
import type { ChatMessage, LLMOptions, LLMProvider } from '@kindora/llm';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';
import {
  buildChatAssistContext,
  type BuildChatAssistContextOptions,
  type ChatHistoryEntryLike,
} from './context-builder';
import { computeHeuristics } from './heuristics';
import {
  parseChatAssistReply,
  type ChatAssistReply,
  type ParseChatAssistResult,
} from './output-parser';

export interface GenerateChatAssistConfig {
  readonly maxChatAssistTokens: number;
}

export interface GenerateChatAssistInput {
  readonly selfProfile: SocialProfile;
  readonly selfDisplayName?: string;
  readonly selfAgentId: string;
  readonly peerProfile: SocialProfile;
  readonly peerDisplayName?: string;
  /** Optional analysis — gives the LLM extra grounding. */
  readonly analysis?: MatchAnalysis | null;
  /** Recent chat history (live ChatOrchestrator snapshot). */
  readonly history: readonly ChatHistoryEntryLike[];
  /** Free-text user query — what they typed in "Ask My Agent". */
  readonly userQuery: string;
}

export interface GenerateChatAssistOptions {
  /** Overrides the default token budget for the system+user prompt. */
  readonly tokenBudget?: number;
  /** Forwarded to `LLMProvider.chat`. */
  readonly llm?: LLMOptions;
}

export interface GenerateChatAssistResult {
  readonly reply: ChatAssistReply;
  /** Messages actually sent to the LLM — handy for logging / tests. */
  readonly messages: readonly ChatMessage[];
  /** Tokens consumed (best-effort estimate). */
  readonly estimatedTokens: number;
  /** Raw model reply, kept for debugging — never contains secrets. */
  readonly rawResponse: string;
  /** True iff the parser had to fall back to defaults. */
  readonly degraded: boolean;
  /** Reason for degradation, if any. */
  readonly degradationNote: string | null;
  /** True iff we short-circuited BEFORE calling the LLM (boundary block). */
  readonly boundaryBlocked: boolean;
}

/**
 * Generate up to 4 chat-assist suggestions.
 *
 * The function is idempotent and side-effect free — call it again to
 * "Regenerate". It never auto-sends.
 */
export async function generateChatAssist(
  provider: LLMProvider,
  input: GenerateChatAssistInput,
  config: GenerateChatAssistConfig = { maxChatAssistTokens: 1200 },
  options: GenerateChatAssistOptions = {},
): Promise<GenerateChatAssistResult> {
  const contextOptions: BuildChatAssistContextOptions = {
    maxTokens: options.tokenBudget ?? config.maxChatAssistTokens,
  };

  // Boundary short-circuit (§ 35): if both sides disable agent
  // conversation, no chat assist is possible. We surface an empty reply
  // without paying for an LLM call.
  const hints = computeHeuristics(input.selfProfile, input.peerProfile);
  if (hints.blockingIssues.length > 0) {
    const messages = buildChatAssistContext(input, contextOptions);
    const tokens = estimateTotal(messages);
    return {
      reply: { summary: '', suggestions: Object.freeze([]) },
      messages,
      estimatedTokens: tokens,
      rawResponse: '',
      degraded: true,
      degradationNote: 'boundary-block: ' + hints.blockingIssues.join('; '),
      boundaryBlocked: true,
    };
  }

  const messages = buildChatAssistContext(input, contextOptions);
  const tokens = estimateTotal(messages);

  const llmOptions: LLMOptions = {
    temperature: options.llm?.temperature ?? 0.5,
    maxTokens: options.llm?.maxTokens ?? 360,
    signal: options.llm?.signal,
    stop: options.llm?.stop,
  };

  const response = await provider.chat(messages, llmOptions);
  const parsed: ParseChatAssistResult = parseChatAssistReply(response.content);

  return {
    reply: parsed.reply,
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