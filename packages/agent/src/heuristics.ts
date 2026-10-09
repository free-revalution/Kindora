/**
 * Lightweight, deterministic structured matching.
 *
 * Sits in front of the LLM call to give the analyst concrete numbers
 * to ground its narrative. The LLM is not required to follow these
 * hints — they're inputs, not constraints.
 *
 * Heuristics implemented:
 *   - interest overlap (Jaccard on lower-cased tokens)
 *   - activity overlap (Jaccard)
 *   - intent compatibility (same → bonus; some pairs are mutually
 *     exclusive per common sense, e.g. project_partner ↔ activity_partner
 *     is fine but gaming_partner ↔ deep technical discussion can be a
 *     style mismatch)
 *   - boundary compatibility (refuses match if both sides disallow
 *     agent conversation)
 *
 * Pure / synchronous / no I/O. See 开发手册.md § 6, Phase 3, Phase 6.
 */
import type { SocialProfile } from '@kindora/protocol';

export interface HeuristicHints {
  /** Interest tokens shared by both profiles. */
  readonly sharedInterests: readonly string[];
  /** Activity tokens shared by both profiles. */
  readonly sharedActivities: readonly string[];
  /** 0–1 jaccard over interests. */
  readonly interestScore: number;
  /** 0–1 jaccard over activities. */
  readonly activityScore: number;
  /** 0–1 heuristic intent alignment. */
  readonly intentScore: number;
  /** 0–1 weighted composite. */
  readonly compositeScore: number;
  /** Reasons to refuse the match outright. */
  readonly blockingIssues: readonly string[];
}

/* Intent compatibility — pairs that almost never coexist well together. */
const INTENT_PENALTIES: ReadonlyArray<readonly [string, string]> = [
  ['gaming_partner', 'long_term_friendship'],
  ['activity_partner', 'long_term_friendship'],
];

function tokenize(items: readonly string[] | undefined): Set<string> {
  if (!items) return new Set();
  const out = new Set<string>();
  for (const raw of items) {
    const t = raw.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function intentScore(selfIntents: readonly string[], peerIntents: readonly string[]): number {
  if (selfIntents.length === 0 || peerIntents.length === 0) return 0;
  const selfSet = new Set(selfIntents);
  let best = 0;
  for (const peer of peerIntents) {
    if (selfSet.has(peer)) return 1; // exact shared intent — full credit
    let score = 0.5;
    for (const [a, b] of INTENT_PENALTIES) {
      if ((peer === a && selfIntents.includes(b)) || (peer === b && selfIntents.includes(a))) {
        score = 0.2;
        break;
      }
    }
    if (score > best) best = score;
  }
  return best;
}

function boundaryBlocks(self: SocialProfile, peer: SocialProfile): string[] {
  const issues: string[] = [];
  if (!self.boundaries.allowAgentConversation && !peer.boundaries.allowAgentConversation) {
    issues.push('Both profiles disallow agent conversation — no match analysis possible.');
  }
  return issues;
}

export function computeHeuristics(self: SocialProfile, peer: SocialProfile): HeuristicHints {
  const selfInterests = tokenize(self.interests);
  const peerInterests = tokenize(peer.interests);
  const selfActivities = tokenize(self.currentActivities);
  const peerActivities = tokenize(peer.currentActivities);

  const sharedInterests: string[] = [];
  for (const t of selfInterests) if (peerInterests.has(t)) sharedInterests.push(t);

  const sharedActivities: string[] = [];
  for (const t of selfActivities) if (peerActivities.has(t)) sharedActivities.push(t);

  const interestScore = jaccard(selfInterests, peerInterests);
  const activityScore = jaccard(selfActivities, peerActivities);
  const intent = intentScore(
    self.socialIntent as readonly string[],
    peer.socialIntent as readonly string[],
  );

  // Composite — interests and intent weigh more than activities.
  const composite = Math.min(1, interestScore * 0.5 + intent * 0.35 + activityScore * 0.15);

  const blockingIssues = boundaryBlocks(self, peer);

  return Object.freeze({
    sharedInterests: Object.freeze(sharedInterests),
    sharedActivities: Object.freeze(sharedActivities),
    interestScore,
    activityScore,
    intentScore: intent,
    compositeScore: composite,
    blockingIssues: Object.freeze(blockingIssues),
  });
}

/** Render hints as a short, deterministic block to embed in the user prompt. */
export function renderHeuristics(hints: HeuristicHints): string {
  const lines: string[] = [];
  lines.push(
    'Structured matching hints (use to ground your explanation, but trust the profiles over the numbers):',
  );
  lines.push(
    `- interest overlap (jaccard): ${hints.interestScore.toFixed(2)} → ${formatSet(hints.sharedInterests)}`,
  );
  lines.push(
    `- activity overlap (jaccard): ${hints.activityScore.toFixed(2)} → ${formatSet(hints.sharedActivities)}`,
  );
  lines.push(`- intent alignment:           ${hints.intentScore.toFixed(2)}`);
  lines.push(`- composite score:            ${hints.compositeScore.toFixed(2)}`);
  if (hints.blockingIssues.length > 0) {
    lines.push('- blocking issues:');
    for (const issue of hints.blockingIssues) lines.push(`    - ${issue}`);
  }
  return lines.join('\n');
}

function formatSet(items: readonly string[]): string {
  if (items.length === 0) return '(none shared)';
  return items.join(', ');
}
