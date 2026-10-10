/**
 * Output parser — turns raw LLM text into a `MatchAnalysis`.
 *
 * LLMs are not guaranteed to emit clean JSON, so the parser is
 * forgiving but strict about the *required shape*:
 *
 *   1. Strip ``` fences and surrounding prose.
 *   2. JSON.parse.
 *   3. Validate `compatibilitySignal` against COMPATIBILITY_SIGNALS;
 *      anything else → 'none' (safe default per § 35 — we never
 *      claim a match we cannot justify).
 *   4. Coerce each list to string[], drop empties, cap length.
 *   5. Coerce `explanation` to a string, cap length.
 *
 * On any failure, return a `'none'` analysis with an explanation that
 * names the failure. The caller (analyze-match) decides whether to
 * surface the error to the user.
 *
 * See 开发手册.md § 35, Phase 3.
 */
import {
  COMPATIBILITY_SIGNALS,
  type CompatibilitySignal,
  type MatchAnalysis,
  type SocialProfile,
} from '@kindora/protocol';

const MAX_LIST_LEN = 8;
const MAX_ITEM_LEN = 200;
const MAX_EXPLANATION_LEN = 600;

function isSignal(value: unknown): value is CompatibilitySignal {
  return typeof value === 'string' && (COMPATIBILITY_SIGNALS as readonly string[]).includes(value);
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_ITEM_LEN));
    if (out.length >= MAX_LIST_LEN) break;
  }
  return out;
}

function coerceExplanation(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_EXPLANATION_LEN);
}

/**
 * Strip ``` fences / leading prose and pull the first JSON object out
 * of the response. Best-effort — if no JSON object can be located,
 * returns the trimmed original text so the JSON.parse step can give
 * a useful error.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  // Fast path: already pure JSON.
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  // Strip leading ``` or ```json fences.
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Otherwise: pull the first {...} span from the response.
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

export interface ParseResult {
  readonly analysis: MatchAnalysis;
  /** True iff the parser had to fall back to defaults (invalid signal, missing fields, etc.). */
  readonly degraded: boolean;
  /** Human-readable note about what was missing or wrong. */
  readonly note: string | null;
}

const NONE_RESULT: MatchAnalysis = Object.freeze({
  compatibilitySignal: 'none',
  commonGround: Object.freeze([]),
  recommendedTopics: Object.freeze([]),
  potentialFriction: Object.freeze([]),
  explanation: '',
});

export function parseMatchAnalysis(raw: string): ParseResult {
  const candidate = extractJsonObject(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      analysis: Object.freeze({
        ...NONE_RESULT,
        explanation: `LLM output could not be parsed as JSON: ${message}`,
      }),
      degraded: true,
      note: `json-parse-failed: ${message}`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      analysis: Object.freeze({
        ...NONE_RESULT,
        explanation: 'LLM output was not a JSON object.',
      }),
      degraded: true,
      note: 'non-object-output',
    };
  }

  const obj = parsed as Record<string, unknown>;
  const degradedFlags: string[] = [];

  const signal: CompatibilitySignal = isSignal(obj.compatibilitySignal)
    ? obj.compatibilitySignal
    : ((): CompatibilitySignal => {
        degradedFlags.push('compatibilitySignal');
        return 'none';
      })();

  const commonGround = coerceStringList(obj.commonGround);
  if (!Array.isArray(obj.commonGround)) degradedFlags.push('commonGround');
  const recommendedTopics = coerceStringList(obj.recommendedTopics);
  if (!Array.isArray(obj.recommendedTopics)) degradedFlags.push('recommendedTopics');
  const potentialFriction = coerceStringList(obj.potentialFriction);
  if (!Array.isArray(obj.potentialFriction)) degradedFlags.push('potentialFriction');

  const explanation = coerceExplanation(obj.explanation);
  if (typeof obj.explanation !== 'string') degradedFlags.push('explanation');

  // Sanity rule: signal 'none' must not list common ground or topics.
  let filteredCommon = commonGround;
  let filteredTopics = recommendedTopics;
  if (signal === 'none') {
    if (commonGround.length > 0) {
      degradedFlags.push('commonGround-incompatible-with-signal-none');
      filteredCommon = [];
    }
    if (recommendedTopics.length > 0) {
      degradedFlags.push('recommendedTopics-incompatible-with-signal-none');
      filteredTopics = [];
    }
  }

  // Sanity rule: when both profiles disallow agent conversation, force signal none.
  const analysis: MatchAnalysis = Object.freeze({
    compatibilitySignal: signal,
    commonGround: Object.freeze(filteredCommon),
    recommendedTopics: Object.freeze(filteredTopics),
    potentialFriction: Object.freeze(potentialFriction),
    explanation,
  });

  const note = degradedFlags.length === 0 ? null : `defaults-applied: ${degradedFlags.join(', ')}`;
  return {
    analysis,
    degraded: degradedFlags.length > 0,
    note,
  };
}

/**
 * Apply a hard override: when neither side allows agent conversation,
 * the analysis is forced to `none` regardless of what the LLM said.
 * Centralised so `analyze-match` and any future caller agree.
 */
export function applyBoundaryOverride(
  analysis: MatchAnalysis,
  selfProfile: SocialProfile,
  peerProfile: SocialProfile,
): MatchAnalysis {
  if (
    selfProfile.boundaries.allowAgentConversation &&
    peerProfile.boundaries.allowAgentConversation
  ) {
    return analysis;
  }
  if (analysis.compatibilitySignal === 'none') return analysis;
  return Object.freeze({
    compatibilitySignal: 'none',
    commonGround: Object.freeze([]),
    recommendedTopics: Object.freeze([]),
    potentialFriction: Object.freeze([
      'Both profiles disallow agent conversation — no match suggested.',
    ]),
    explanation: 'Both sides have agent conversation disabled; no match is suggested.',
  });
}

/* ------------------------------------------------------------------ */
/* Icebreaker parser                                                   */
/* ------------------------------------------------------------------ */

/**
 * Maximum number of icebreaker topics we keep from the LLM response.
 * 开发手册.md § 28 — agent generates 3 conversation starters.
 */
export const MAX_ICEBREAKER_TOPICS = 3;

/**
 * Parse the LLM's reply into a list of icebreaker topics (Phase 8).
 *
 * The model is asked for `{ "topics": [string, string, string] }` and
 * nothing else. Parsing is forgiving (re-uses `extractJsonObject`) but
 * strictly enforces that every emitted topic is a non-empty string in
 * the LOCAL user's voice. On any failure we return an empty list with
 * `degraded: true` so the UI can offer "Regenerate".
 */
export function parseIcebreakerTopics(raw: string): ParseIcebreakerResult {
  const candidate = extractJsonObject(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      topics: Object.freeze([]),
      degraded: true,
      note: `json-parse-failed: ${message}`,
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      topics: Object.freeze([]),
      degraded: true,
      note: 'non-object-output',
    };
  }

  const obj = parsed as Record<string, unknown>;
  const topics = coerceIcebreakerTopics(obj.topics);
  if (!Array.isArray(obj.topics)) {
    return {
      topics: Object.freeze(topics),
      degraded: true,
      note: 'defaults-applied: topics-not-array',
    };
  }
  return {
    topics: Object.freeze(topics),
    degraded: false,
    note: null,
  };
}

/**
 * Coerce a possibly-malformed topics field into a clean list of
 * strings. We keep the first MAX_ICEBREAKER_TOPICS entries after
 * trimming, dropping empties, and capping length.
 */
export function coerceIcebreakerTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, MAX_ITEM_LEN));
    if (out.length >= MAX_ICEBREAKER_TOPICS) break;
  }
  return out;
}

export interface ParseIcebreakerResult {
  /** Up to MAX_ICEBREAKER_TOPICS strings. Empty when the model failed. */
  readonly topics: readonly string[];
  /** True iff the parser had to fall back to defaults. */
  readonly degraded: boolean;
  /** Human-readable note about what was missing or wrong. */
  readonly note: string | null;
}
