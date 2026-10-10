/**
 * @kindora/matching
 *
 * Two-stage compatibility engine.
 * Phase 0: data shapes only.
 * Phase 6: orchestrator driving the KSA wire flow + display helpers.
 *
 * The display layer consumes the `MatchAnalysis` shape from
 * `@kindora/protocol` (compatibilitySignal, commonGround,
 * recommendedTopics, potentialFriction, explanation) — that's the
 * schema Phase 3's `analyzeMatch` produces. The local `MatchResult`
 * below is a future-facing shape for the structured-scoring pass
 * (Phase 6+ / Phase 13) and is not yet populated.
 *
 * See 开发手册.md § 6, § 24–25, Phase 6.
 */

export interface PublicProfile {
  readonly agentId: string;
  readonly displayName: string;
  readonly bio: string;
  readonly interests: readonly string[];
  readonly currentActivities: readonly string[];
  readonly socialIntent: readonly string[];
  readonly conversationStyle: readonly string[];
}

export interface MatchResult {
  /** A 0–100 compatibility signal, NOT a friendship probability. */
  readonly score: number;
  readonly commonGround: readonly string[];
  readonly recommendedTopics: readonly string[];
  readonly potentialRelationshipTypes: readonly string[];
  readonly potentialFriction: readonly string[];
  readonly explanation: string;
  /** Confidence in the result itself, 0–1. */
  readonly confidence: number;
}

export const MATCHING_PACKAGE_VERSION = '0.1.0';

export {
  MatchOrchestrator,
  DEFAULT_PEER_ANALYSIS_TIMEOUT_MS,
  DEFAULT_EARLY_WAIT_TIMEOUT_MS,
  type MatchOrchestratorSelf,
  type MatchOutcome,
} from './orchestrator';

export {
  ConsentOrchestrator,
  DEFAULT_PEER_CONSENT_TIMEOUT_MS,
  type ConsentDecision,
  type ConsentState,
  type ConsentOutcome,
  type ConsentOrchestratorOptions,
  type BlockedAgentsLookup,
} from './consent-orchestrator';

export {
  ChatOrchestrator,
  DEFAULT_CHAT_TEXT_MAX_LENGTH,
  type ChatEntry,
  type ChatSnapshot,
  type ChatListener,
  type ChatCloseReason,
  type ChatOrchestratorOptions,
} from './chat-orchestrator';

export {
  compatibilityLabel,
  formatExplanation,
  formatList,
  summariseAnalysis,
  type CompatibilityLabel,
  type CompatibilityTone,
  type AnalysisSummary,
} from './display';

export {
  ChatAssistOrchestrator,
  summariseChatAssist,
  type ChatAssistHandle,
  type ChatAssistHistoryEntry,
  type ChatAssistOrchestratorOptions,
  type ChatAssistDisplay,
  type ChatAssistDisplaySuggestion,
  type ChatAssistReply,
  type ChatAssistSuggestion,
  type ChatAssistKind,
} from './chat-assist-orchestrator';
