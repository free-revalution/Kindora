/**
 * @kindora/matching
 *
 * Two-stage compatibility engine.
 * Phase 0: data shapes only — algorithms land in Phase 6.
 *
 * See 开发手册.md § 24–25.
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
