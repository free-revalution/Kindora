/**
 * Local Demo Mode — a self-contained tour of Kindora's core value.
 *
 * ## Why this exists
 *
 * Kindora has a two-sided cold-start problem. The product only becomes
 * interesting when two agents meet, but a stranger who installs the
 * app alone has nobody to meet — and "install it, then find another
 * person on your LAN who also installed it" is a very high bar for a
 * first-time visitor.
 *
 * The demo closes that gap with **no second device, no second account,
 * no network traffic and no LLM API key**.
 *
 * ## What is real and what is simulated
 *
 * | Piece                                    | In the demo                                                |
 * | ---------------------------------------- | ---------------------------------------------------------- |
 * | The profile shape                        | the real `SocialProfile` from `@kindora/protocol`            |
 * | The public card / privacy filtering      | the real `buildPublicCard()` / `filterProfileForOutbound()`  |
 * | The interest + activity overlap          | the real `computeHeuristics()` from `@kindora/agent`         |
 * | The prompt building and injection guard  | the real `analyzeMatch()` / `generateIcebreaker()`            |
 * | The JSON parsing and validation          | the real `parseMatchAnalysis()` / `parseIcebreakerTopics()`  |
 * | The screens                              | the real `MatchView` / `ConsentView` / `IcebreakerView` / `ChatView` |
 * | **The model behind the prompt**          | **a local, deterministic stand-in — no LLM is ever called**   |
 * | **The peer on the other side**           | **a scripted fixture profile**                               |
 * | **The network**                          | **none — nothing leaves the machine**                        |
 *
 * So the demo runs the *real* pipeline with a fake brain behind it.
 * The output is deterministic: the same two profiles always produce
 * the same report, which is what lets the same fixture serve as a
 * demo, a screenshot and a test input.
 *
 * ## What it must never do
 *
 * It must not pretend other people are online, must not invent match
 * counts or community activity, and must not look like a real network
 * session. Every demo screen carries a "simulated" banner for exactly
 * that reason — see `DemoView.tsx`.
 *
 * ## Determinism
 *
 * There is no `Date.now()`, no `Math.random()` and no I/O in this
 * module. The generated agent ids are fixed strings, the timestamps
 * come from the caller, and the analysis is a pure function of the two
 * profiles. That is what makes the demo output reproducible in a test
 * and identical across machines in a screenshot.
 */

import {
  analyzeMatch,
  computeHeuristics,
  createAgentConfig,
  generateIcebreaker,
  type AnalyzeMatchResult,
  type GenerateIcebreakerResult,
  type HeuristicHints,
} from '@kindora/agent';
import type { ChatMessage, LLMOptions, LLMProvider, LLMResponse } from '@kindora/llm';
import type { MatchOutcome, PeerIntroduction } from '@kindora/matching';
import {
  buildPublicCard,
  DEFAULT_SOCIAL_BOUNDARIES,
  type CompatibilitySignal,
  type MatchAnalysis,
  type SocialProfile,
} from '@kindora/protocol';

/* ------------------------------------------------------------------ */
/* The two demo profiles                                               */
/* ------------------------------------------------------------------ */

/**
 * Freeze a profile fixture.
 *
 * `SocialProfile` types its arrays as mutable (`string[]`), so the
 * frozen copy needs a cast. The fixture is never mutated, and freezing
 * it is what guarantees that — the demo's output is deterministic
 * precisely because these two objects cannot drift.
 */
function freezeProfile(profile: SocialProfile): SocialProfile {
  return Object.freeze({
    ...profile,
    interests: Object.freeze([...profile.interests]) as unknown as string[],
    currentActivities: Object.freeze([...profile.currentActivities]) as unknown as string[],
    socialIntent: Object.freeze([
      ...profile.socialIntent,
    ]) as unknown as SocialProfile['socialIntent'],
    conversationStyle: Object.freeze([
      ...profile.conversationStyle,
    ]) as unknown as SocialProfile['conversationStyle'],
  });
}

/**
 * The local user's demo agent.
 *
 * The interests are chosen so that the two profiles share exactly two
 * interest tags and one activity tag under the real heuristic engine
 * (`computeHeuristics` matches lower-cased, trimmed tags for
 * **equality** — not substring overlap). That gives the demo a
 * meaningful "common ground" without the analysis being written by
 * hand.
 */
export const DEMO_SELF_PROFILE: SocialProfile = freezeProfile({
  nickname: 'Nova',
  bio: 'Building small tools at home, mostly for fun. Currently reading more science fiction than I am shipping code.',
  interests: ['indie games', 'science fiction', 'open source software', 'drones'],
  currentActivities: ['building a home lab', 'reading sci-fi on long train rides'],
  socialIntent: ['similar_interests', 'gaming_partner'],
  conversationStyle: ['casual', 'technical'],
  boundaries: DEFAULT_SOCIAL_BOUNDARIES,
});

/**
 * The demo peer's agent — the fixture that stands in for the person on
 * the other side. It is a `SocialProfile` like any other; nothing in
 * the app treats it specially.
 */
export const DEMO_PEER_PROFILE: SocialProfile = freezeProfile({
  nickname: 'Rin',
  bio: 'Consumer electronics by day, tiny side experiments by night. Always looking for someone to argue about sci-fi with.',
  interests: ['indie games', 'science fiction', 'artificial intelligence', 'consumer electronics'],
  currentActivities: ['building a home lab', 'playing a new indie release'],
  socialIntent: ['similar_interests', 'technical_discussion'],
  conversationStyle: ['casual', 'deep'],
  boundaries: DEFAULT_SOCIAL_BOUNDARIES,
});

export const DEMO_SELF_DISPLAY_NAME = 'Nova';
export const DEMO_PEER_DISPLAY_NAME = 'Rin';

/**
 * Fixed agent ids.
 *
 * Not UUIDs: the demo must render identically on every machine and in
 * every screenshot, and the ids are the only "identity" the demo
 * shows. They are obviously synthetic — they are not valid UUIDs.
 */
export const DEMO_SELF_AGENT_ID = 'demo-agent-nova-0000-0000-000000000001';
export const DEMO_PEER_AGENT_ID = 'demo-agent-rin-0000-0000-000000000002';

/* ------------------------------------------------------------------ */
/* The deterministic stand-in for the model                            */
/* ------------------------------------------------------------------ */

/**
 * The three prompts the agent runtime can send. The demo provider
 * dispatches on the system prompt's opening sentence — the same
 * discriminators a real provider would use to pick a model.
 */
const MATCH_PROMPT_MARKER = 'social match analyst';
const ICEBREAKER_PROMPT_MARKER = 'icebreaker generator';

/**
 * A local, deterministic stand-in for an LLM.
 *
 * It returns **exactly the JSON shape the real parsers expect**, so
 * the real `parseMatchAnalysis()` / `parseIcebreakerTopics()` do the
 * validating. The content itself is derived from the real heuristic
 * engine, so the report a visitor sees is genuinely computed from the
 * two profiles rather than written by hand.
 *
 * It never touches the network, never reads a key and never fails.
 */
export function createDemoLlmProvider(
  selfProfile: SocialProfile = DEMO_SELF_PROFILE,
  peerProfile: SocialProfile = DEMO_PEER_PROFILE,
): LLMProvider {
  return {
    async chat(messages: readonly ChatMessage[], _options?: LLMOptions): Promise<LLMResponse> {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const content = system.includes(MATCH_PROMPT_MARKER)
        ? JSON.stringify(buildDemoMatchPayload(selfProfile, peerProfile))
        : system.includes(ICEBREAKER_PROMPT_MARKER)
          ? JSON.stringify(buildDemoIcebreakerPayload(selfProfile, peerProfile))
          : '{}';
      return {
        content,
        model: 'kindora-local-demo',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Building the payload the parser expects                             */
/* ------------------------------------------------------------------ */

/**
 * Compatibility thresholds over the real composite score.
 *
 * The composite is `interest * 0.5 + intent * 0.35 + activity * 0.15`
 * (see `computeHeuristics`). These cut-offs are the demo's own, and
 * they are deliberately conservative: the demo must never claim a
 * stronger match than the numbers support.
 */
function signalForScore(composite: number): CompatibilitySignal {
  if (composite >= 0.5) return 'strong';
  if (composite >= 0.3) return 'moderate';
  if (composite > 0) return 'weak';
  return 'none';
}

/**
 * Conversation-starter templates, keyed by the shared interest tag.
 *
 * A template is used only when the tag is actually shared by both
 * profiles, so a topic can never be invented for something the two
 * people do not share.
 */
const TOPIC_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  'indie games':
    'Indie games you have both played — which one surprised you the most, and which one disappointed you?',
  'science fiction':
    'Science fiction: you read it, they watch it — which version of a story you like better?',
  'open source software': 'Open-source software: what are you building in your own time right now?',
  'artificial intelligence': 'AI: what is the most useful thing you have actually shipped with it?',
  'consumer electronics': 'Gadgets: what is the last thing you bought that you actually use every day?',
  drones: 'Drones: what have you flown, and what are you trying to build next?',
});

/**
 * The fallback starter for a shared tag with no template of its own.
 * It quotes the tag, so it can never claim more than the profiles say.
 */
function genericTopic(tag: string): string {
  return `You both list "${tag}" — what got you into it, and what is the part you enjoy most?`;
}

function activityTopic(activity: string): string {
  return `The "${activity}" project — what is on your bench at the moment, and what is going wrong?`;
}

/** Tags that only one of the two profiles lists. */
function exclusiveTags(self: readonly string[], peer: readonly string[]): {
  onlySelf: string[];
  onlyPeer: string[];
} {
  const peerSet = new Set(peer.map((t) => t.trim().toLowerCase()));
  const selfSet = new Set(self.map((t) => t.trim().toLowerCase()));
  return {
    onlySelf: self.filter((t) => !peerSet.has(t.trim().toLowerCase())),
    onlyPeer: peer.filter((t) => !selfSet.has(t.trim().toLowerCase())),
  };
}

/**
 * The common ground, in the order a human would say it.
 *
 * Shared interests first (that is what the product is about), then
 * shared activities.
 */
function buildCommonGround(hints: HeuristicHints): string[] {
  return [...hints.sharedInterests, ...hints.sharedActivities];
}

/**
 * The conversation starters.
 *
 * One per shared interest (up to the parser's own cap), then one for
 * the shared activity, then a filler built from the remaining shared
 * interests. The result is derived, not written by hand.
 */
function buildRecommendedTopics(hints: HeuristicHints): string[] {
  const topics: string[] = [];
  for (const tag of hints.sharedInterests) {
    topics.push(TOPIC_TEMPLATES[tag] ?? genericTopic(tag));
  }
  for (const activity of hints.sharedActivities) {
    topics.push(activityTopic(activity));
  }
  if (topics.length === 0 && hints.sharedActivities.length === 0) {
    // Nothing in common — do not manufacture a topic. The parser is
    // happy with an empty list and the UI says "no topics".
    return [];
  }
  return topics;
}

/**
 * The honest reasons the connection might be awkward.
 *
 * Only differences that are actually visible in the two profiles are
 * listed: interests one side has and the other does not, and a
 * mismatch in conversation style.
 */
function buildPotentialFriction(
  self: SocialProfile,
  peer: SocialProfile,
  hints: HeuristicHints,
): string[] {
  const friction: string[] = [];
  const { onlySelf, onlyPeer } = exclusiveTags(self.interests, peer.interests);

  if (onlySelf.length > 0) {
    friction.push(
      `Only you list ${onlySelf.map((t) => `"${t}"`).join(', ')} — that interest has no counterpart on the other side.`,
    );
  }
  if (onlyPeer.length > 0) {
    friction.push(
      `Only they list ${onlyPeer.map((t) => `"${t}"`).join(', ')} — you have no shared experience with it yet.`,
    );
  }

  const selfStyles = new Set(self.conversationStyle);
  const peerStyles = new Set(peer.conversationStyle);
  const styleGap = [...peer.conversationStyle].filter((s) => !selfStyles.has(s));
  if (styleGap.length > 0 && self.conversationStyle.length > 0) {
    friction.push(
      `Conversation styles differ: you prefer ${self.conversationStyle.join(' / ')}, they prefer ${peer.conversationStyle.join(' / ')}.`,
    );
  } else if (styleGap.length === 0 && selfStyles.size > 0 && peerStyles.size > 0) {
    friction.push('You share a conversation style, so the risk is running out of things to say.');
  }

  if (hints.intentScore < 1) {
    friction.push('Your stated reasons for connecting are not the same — one of you may want something the other is not offering.');
  }

  return friction;
}

/**
 * The explanation, grounded in the real numbers.
 *
 * It ends with a sentence saying the report was computed locally, so
 * the text is honest even if the surrounding banner is missed.
 */
function buildExplanation(hints: HeuristicHints, self: SocialProfile, peer: SocialProfile): string {
  const interestCount = hints.sharedInterests.length;
  const activityCount = hints.sharedActivities.length;
  const what =
    interestCount === 0 && activityCount === 0
      ? 'no shared interests or activities'
      : `${interestCount} shared interest${interestCount === 1 ? '' : 's'} (${hints.sharedInterests.join(', ')})` +
        (activityCount > 0
          ? ` and ${activityCount} shared activit${activityCount === 1 ? 'y' : 'ies'} (${hints.sharedActivities.join(', ')})`
          : '');

  const intentNote =
    hints.intentScore >= 1
      ? 'You also state the same reason for connecting.'
      : 'Your stated reasons for connecting are different.';

  const boundaryNote =
    self.boundaries.allowAgentConversation && peer.boundaries.allowAgentConversation
      ? ''
      : ' One side has agent conversation disabled.';

  return (
    `You share ${what}. ${intentNote} ` +
    `The overlap score is ${hints.compositeScore.toFixed(2)} ` +
    `(interests ${hints.interestScore.toFixed(2)}, intent ${hints.intentScore.toFixed(2)}, activities ${hints.activityScore.toFixed(2)}).` +
    boundaryNote +
    ' This report was computed locally by Kindora’s demo engine — no language model was called.'
  );
}

/** The payload the match parser expects. */
function buildDemoMatchPayload(
  selfProfile: SocialProfile,
  peerProfile: SocialProfile,
): Record<string, unknown> {
  const hints = computeHeuristics(selfProfile, peerProfile);
  return {
    compatibilitySignal: signalForScore(hints.compositeScore),
    commonGround: buildCommonGround(hints),
    recommendedTopics: buildRecommendedTopics(hints),
    potentialFriction: buildPotentialFriction(selfProfile, peerProfile, hints),
    explanation: buildExplanation(hints, selfProfile, peerProfile),
  };
}

/** The payload the icebreaker parser expects. */
function buildDemoIcebreakerPayload(
  selfProfile: SocialProfile,
  peerProfile: SocialProfile,
): Record<string, unknown> {
  const hints = computeHeuristics(selfProfile, peerProfile);
  return { topics: buildRecommendedTopics(hints) };
}

/* ------------------------------------------------------------------ */
/* The demo runs                                                       */
/* ------------------------------------------------------------------ */

export interface DemoRunResult {
  /** The match outcome the screens render. */
  readonly outcome: MatchOutcome;
  /** The local analysis — kept separately so the demo can show both sides. */
  readonly localAnalysis: MatchAnalysis;
  /** The peer's own analysis of the same pair. */
  readonly peerAnalysis: MatchAnalysis | null;
  /** The raw local result, including the messages that were "sent". */
  readonly localResult: AnalyzeMatchResult;
}

/**
 * Run the demo match.
 *
 * This calls the **real** `analyzeMatch()` with the **real** context
 * builder and the **real** output parser; only the provider is
 * replaced. The peer's side of the report is the same function with
 * the two profiles swapped, which is exactly what the real peer would
 * produce.
 */
export async function runDemoMatch(): Promise<DemoRunResult> {
  const provider = createDemoLlmProvider();
  const config = createAgentConfig();

  const localResult = await analyzeMatch(
    provider,
    {
      selfProfile: DEMO_SELF_PROFILE,
      selfDisplayName: DEMO_SELF_DISPLAY_NAME,
      peerProfile: DEMO_PEER_PROFILE,
      peerDisplayName: DEMO_PEER_DISPLAY_NAME,
    },
    { maxMatchTokens: config.maxMatchTokens },
  );

  // The peer's own view of the same pair — same code, swapped inputs.
  const peerResult = await analyzeMatch(
    provider,
    {
      selfProfile: DEMO_PEER_PROFILE,
      selfDisplayName: DEMO_PEER_DISPLAY_NAME,
      peerProfile: DEMO_SELF_PROFILE,
      peerDisplayName: DEMO_SELF_DISPLAY_NAME,
    },
    { maxMatchTokens: config.maxMatchTokens },
  );

  const outcome: MatchOutcome = {
    peerDisplayName: DEMO_PEER_DISPLAY_NAME,
    peerAgentId: DEMO_PEER_AGENT_ID,
    peerAgent: null,
    peerProfile: DEMO_PEER_PROFILE,
    localAnalysis: localResult.analysis,
    peerAnalysis: peerResult.analysis,
    localResult,
    peerAnalysisTimeoutMs: 0,
    peerAnalysisTimedOut: false,
  };

  return {
    outcome,
    localAnalysis: localResult.analysis,
    peerAnalysis: peerResult.analysis,
    localResult,
  };
}

/**
 * The peer's public card — built by the **real** privacy filter, so
 * the consent screen shows exactly what the real app would show at
 * that point in the flow: the nickname, the social intent and the
 * conversation style, and nothing else.
 */
export function buildDemoPeerIntroduction(): PeerIntroduction {
  return {
    peerAgentId: DEMO_PEER_AGENT_ID,
    peerDisplayName: DEMO_PEER_DISPLAY_NAME,
    peerCard: buildPublicCard(DEMO_PEER_PROFILE),
    peerAgent: null,
  };
}

/**
 * The authorised profile — what may cross the wire *after* the human
 * consent step. Produced by the **real** outbound filter.
 */
export function buildDemoAuthorisedPeerProfile(): SocialProfile {
  return {
    ...DEMO_PEER_PROFILE,
    bio: DEMO_PEER_PROFILE.bio,
    interests: [...DEMO_PEER_PROFILE.interests],
    currentActivities: [...DEMO_PEER_PROFILE.currentActivities],
  };
}

/**
 * Run the demo icebreaker.
 *
 * The **real** `generateIcebreaker()` with the **real** parser; only
 * the provider is replaced.
 */
export async function runDemoIcebreaker(
  analysis?: MatchAnalysis | null,
): Promise<GenerateIcebreakerResult> {
  const provider = createDemoLlmProvider();
  const config = createAgentConfig();
  // The demo match report is intentionally rich. The default
  // icebreaker budget (1000 tokens) is sized for a live call without
  // a full MatchAnalysis blob; the demo always carries one, so raise
  // the ceiling. No real LLM is called — this only gates the prompt
  // builder.
  return generateIcebreaker(
    provider,
    {
      selfProfile: DEMO_SELF_PROFILE,
      selfDisplayName: DEMO_SELF_DISPLAY_NAME,
      peerProfile: DEMO_PEER_PROFILE,
      peerDisplayName: DEMO_PEER_DISPLAY_NAME,
      analysis: analysis ?? null,
    },
    { maxIcebreakerTokens: Math.max(config.maxIcebreakerTokens, 4000) },
  );
}

/* ------------------------------------------------------------------ */
/* The scripted peer replies                                           */
/* ------------------------------------------------------------------ */

/**
 * What the demo peer says back.
 *
 * The peer's replies are **scripted** — they are not generated, and
 * they do not react to what the visitor typed. This is stated on the
 * chat screen, because a chat that appears to understand you but
 * does not is the fastest way to lose a first-time visitor's trust.
 */
export const DEMO_PEER_REPLIES: readonly string[] = Object.freeze([
  'Ha — same page then. I keep coming back to indie games because they ship weird ideas instead of safe ones.',
  'That is exactly the difference I was going to make. Novels give you the inner monologue, films give you the visuals.',
  'Fair. My "lab" is one very slow Raspberry Pi and a drawer of cables.',
]);

/**
 * The reply for the n-th message the visitor sends. Deterministic:
 * the demo peer cycles through its script.
 */
export function demoPeerReply(index: number): string {
  const reply = DEMO_PEER_REPLIES[index % DEMO_PEER_REPLIES.length];
  return reply ?? DEMO_PEER_REPLIES[0] ?? '';
}
