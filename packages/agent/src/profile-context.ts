/**
 * Render a SocialProfile into a deterministic, human-readable context
 * string suitable for inclusion in a system / user prompt.
 *
 * The renderer is:
 *   - Wholly local. No network, no I/O.
 *   - Field-bounded: every field has an upper length so a malicious or
 *     malformed peer profile cannot blow out the LLM context.
 *   - Deterministic: same profile → same output. (Required so test
 *     assertions and snapshot-style checks are stable.)
 *
 * See 开发手册.md § 9, § 35.
 */
import type { SocialProfile } from '@kindora/protocol';

/**
 * Per-field character caps applied when rendering.
 *
 * These mirror the validation limits in `@kindora/agent/profile`
 * with extra headroom for already-validated input. The renderer
 * truncates defensively in case a peer profile bypassed validation
 * (e.g. arrived over the wire in Phase 4+).
 */
const FIELD_CAPS = {
  nickname: 64,
  bio: 400,
  listItem: 80,
  listCount: 16,
  intent: 40,
  style: 20,
} as const;

function clip(s: string | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function renderList(
  items: readonly string[] | undefined,
  itemCap: number,
  countCap: number,
): string {
  if (!items || items.length === 0) return '(none)';
  const trimmed = items
    .slice(0, countCap)
    .map((i) => clip(i.trim(), itemCap))
    .filter(Boolean);
  if (trimmed.length === 0) return '(none)';
  return trimmed.join(', ');
}

export interface ProfileContextOptions {
  /** Display label (e.g. "self" or "peer"). Defaults to "Profile". */
  readonly label?: string;
  /** Optional display name to print alongside the profile. */
  readonly displayName?: string;
}

/**
 * Render a profile to a multi-line context block.
 *
 * The output looks like:
 *
 *   Profile [nickname = "alex"]:
 *   - displayName: alex
 *   - bio: ...
 *   - interests: a, b, c
 *   - current activities: x, y
 *   - social intent: similar_interests
 *   - conversation style: deep
 *   - boundaries:
 *       agent conversation: yes
 *       contact exchange: no
 *       offline meeting: no
 *       project details: no
 *       current activity: yes
 */
export function renderProfileContext(
  profile: SocialProfile,
  options: ProfileContextOptions = {},
): string {
  const label = options.label ?? 'Profile';
  const nicknameTag = profile.nickname
    ? ` nickname="${clip(profile.nickname, FIELD_CAPS.nickname)}"`
    : '';
  const lines: string[] = [];
  lines.push(`${label}${nicknameTag}:`);
  if (options.displayName) {
    lines.push(`- displayName: ${clip(options.displayName, FIELD_CAPS.nickname)}`);
  }
  lines.push(`- bio: ${clip(profile.bio, FIELD_CAPS.bio) || '(none)'}`);
  lines.push(
    `- interests: ${renderList(profile.interests as readonly string[], FIELD_CAPS.listItem, FIELD_CAPS.listCount)}`,
  );
  lines.push(
    `- current activities: ${renderList(profile.currentActivities, FIELD_CAPS.listItem, FIELD_CAPS.listCount)}`,
  );
  lines.push(
    `- social intents: ${renderList(profile.socialIntent as readonly string[], FIELD_CAPS.listItem, FIELD_CAPS.listCount)}`,
  );
  lines.push(
    `- conversation styles: ${renderList(profile.conversationStyle as readonly string[], FIELD_CAPS.listItem, FIELD_CAPS.listCount)}`,
  );
  lines.push('- boundaries:');
  const b = profile.boundaries;
  lines.push(`    agent conversation: ${b.allowAgentConversation ? 'yes' : 'no'}`);
  lines.push(`    contact exchange:   ${b.allowContactExchange ? 'yes' : 'no'}`);
  lines.push(`    offline meeting:    ${b.allowOfflineMeeting ? 'yes' : 'no'}`);
  lines.push(`    project details:    ${b.allowProjectDetails ? 'yes' : 'no'}`);
  lines.push(`    current activity:   ${b.allowCurrentActivity ? 'yes' : 'no'}`);
  return lines.join('\n');
}
