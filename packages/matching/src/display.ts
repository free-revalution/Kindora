/**
 * Display helpers for `MatchAnalysis` (from `@kindora/protocol`).
 *
 * Pure formatters — no React, no DOM, no I/O. The `MatchView` React
 * component consumes the `summariseAnalysis()` output as plain
 * strings so the layout stays dumb and the formatters stay
 * unit-testable in isolation.
 *
 * See 开发手册.md § 6, Phase 6.
 */
import type { CompatibilitySignal, MatchAnalysis } from '@kindora/protocol';

export type CompatibilityTone = 'positive' | 'neutral' | 'cautious';

export interface CompatibilityLabel {
  readonly label: string;
  readonly tone: CompatibilityTone;
}

/** Human-friendly label + visual tone for a compatibility signal. */
export function compatibilityLabel(signal: CompatibilitySignal): CompatibilityLabel {
  switch (signal) {
    case 'strong':
      return { label: 'Strong match', tone: 'positive' };
    case 'moderate':
      return { label: 'Moderate match', tone: 'neutral' };
    case 'weak':
      return { label: 'Weak match', tone: 'neutral' };
    case 'none':
      return { label: 'No match', tone: 'cautious' };
  }
}

const DEFAULT_EXPLANATION_MAX = 280;

/**
 * Trim, collapse whitespace, and cap the explanation length with an
 * ellipsis. Empty input falls back to the provided placeholder.
 */
export function formatExplanation(input: string, max = DEFAULT_EXPLANATION_MAX): string {
  const trimmed = input.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return '';
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/** Join an array of items with `·` (or return the fallback when empty). */
export function formatList(items: readonly string[], fallback: string = '—'): string {
  if (items.length === 0) return fallback;
  return items.join(' · ');
}

export interface AnalysisSummary {
  readonly signalLabel: string;
  readonly signalTone: CompatibilityTone;
  readonly commonGround: readonly string[];
  readonly recommendedTopics: readonly string[];
  readonly potentialFriction: readonly string[];
  readonly explanation: string;
}

/** Stable view-model for the 5 fields Phase 6 must display. */
export function summariseAnalysis(analysis: MatchAnalysis): AnalysisSummary {
  const { label, tone } = compatibilityLabel(analysis.compatibilitySignal);
  return {
    signalLabel: label,
    signalTone: tone,
    commonGround: analysis.commonGround,
    recommendedTopics: analysis.recommendedTopics,
    potentialFriction: analysis.potentialFriction,
    explanation: formatExplanation(analysis.explanation),
  };
}
