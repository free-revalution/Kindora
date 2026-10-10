/**
 * ChatAssistOrchestrator — Phase 10.
 *
 * Wires the Phase 10 "Ask My Agent" flow on top of an already-connected
 * chat. The orchestrator:
 *
 *   1. Reads the FRESHEST chat history from a `ChatOrchestrator`
 *      snapshot (via the `getHistory()` accessor the parent passes in).
 *   2. Packages (selfProfile, peerProfile, analysis, history, query)
 *      into a `GenerateChatAssistInput`.
 *   3. Calls `generateChatAssist()` — never auto-sends anything (§ 32).
 *
 * This orchestrator is **read-only** with respect to the chat session:
 * it never sends envelopes, never blocks, never disconnects. Its sole
 * job is to keep the `Ask My Agent` panel fresh with candidate
 * suggestions while the user composes.
 *
 * See 开发手册.md § 31, § 32, Phase 10.
 */
import type { LLMProvider } from '@kindora/llm';
import type {
  ChatAssistReply,
  ChatAssistSuggestion,
  GenerateChatAssistConfig,
  GenerateChatAssistInput,
  GenerateChatAssistResult,
} from '@kindora/agent';
import {
  CHAT_ASSIST_KINDS,
  generateChatAssist,
  type ChatAssistKind,
} from '@kindora/agent';
import type { MatchAnalysis, SocialProfile } from '@kindora/protocol';

export interface ChatAssistHistoryEntry {
  readonly direction: 'sent' | 'received';
  readonly sender: string;
  readonly text: string;
  readonly timestamp: string;
}

export interface ChatAssistOrchestratorOptions {
  /** Optional override for the LLM token budget. */
  readonly tokenBudget?: number;
  /** Optional override for the LLM sampling options. */
  readonly llm?: { readonly temperature?: number; readonly maxTokens?: number };
}

export class ChatAssistOrchestrator {
  private readonly selfAgentId: string;
  private readonly selfProfile: SocialProfile;
  private readonly peerDisplayName: string;
  private readonly peerProfile: SocialProfile | null;
  private readonly analysis: MatchAnalysis | null;
  private readonly getHistory: () => readonly ChatAssistHistoryEntry[];
  private readonly llm: LLMProvider;
  private readonly config: GenerateChatAssistConfig;
  private readonly options: ChatAssistOrchestratorOptions;

  constructor(input: {
    readonly selfAgentId: string;
    readonly selfProfile: SocialProfile;
    readonly peerDisplayName: string;
    readonly peerProfile: SocialProfile | null;
    readonly analysis?: MatchAnalysis | null;
    readonly llm: LLMProvider;
    readonly config: GenerateChatAssistConfig;
    /** Returns the live ChatOrchestrator snapshot's history. */
    readonly getHistory: () => readonly ChatAssistHistoryEntry[];
    readonly options?: ChatAssistOrchestratorOptions;
  }) {
    this.selfAgentId = input.selfAgentId;
    this.selfProfile = input.selfProfile;
    this.peerDisplayName = input.peerDisplayName;
    this.peerProfile = input.peerProfile;
    this.analysis = input.analysis ?? null;
    this.getHistory = input.getHistory;
    this.llm = input.llm;
    this.config = input.config;
    this.options = input.options ?? {};
  }

  /**
   * Run a single "Ask My Agent" round-trip. Returns the parsed reply
   * plus the messages the LLM saw and any degradation note. The caller
   * (the desktop view) renders the suggestions as Use / Edit /
   * Regenerate / Dismiss — per § 32 the assistant never auto-sends.
   *
   * If the peer profile is missing, we build a minimal fallback so the
   * model still has SOMETHING to ground its reply in (the chat history).
   */
  async ask(userQuery: string): Promise<GenerateChatAssistResult> {
    const peerProfile = this.peerProfile ?? minimalPeerProfile(this.peerDisplayName);
    const input: GenerateChatAssistInput = {
      selfProfile: this.selfProfile,
      selfAgentId: this.selfAgentId,
      peerProfile,
      peerDisplayName: this.peerDisplayName,
      analysis: this.analysis,
      history: this.getHistory(),
      userQuery,
    };
    return generateChatAssist(this.llm, input, this.config, {
      tokenBudget: this.options.tokenBudget,
      llm: this.options.llm,
    });
  }

  /** Expose the kinds so the view can render a small chip per suggestion. */
  static readonly kinds = CHAT_ASSIST_KINDS;
}

/** Minimal fallback when the peer sent no profile_exchange envelope. */
function minimalPeerProfile(displayName: string): SocialProfile {
  return {
    nickname: displayName,
    bio: '',
    interests: [],
    currentActivities: [],
    socialIntent: [],
    conversationStyle: [],
    boundaries: {
      allowAgentConversation: true,
      allowContactExchange: false,
      allowOfflineMeeting: false,
      allowProjectDetails: false,
      allowCurrentActivity: true,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Display helpers — pure formatters, no React / no DOM.                */
/* ------------------------------------------------------------------ */

export interface ChatAssistDisplaySuggestion {
  readonly id: string;
  readonly kindLabel: string;
  readonly kind: ChatAssistKind;
  readonly text: string;
  readonly rationale: string;
}

export interface ChatAssistDisplay {
  readonly summary: string;
  readonly suggestions: readonly ChatAssistDisplaySuggestion[];
}

const KIND_LABEL: Record<ChatAssistKind, string> = Object.freeze({
  reply: 'Reply',
  topic: 'Topic',
  explanation: 'Explain',
});

/**
 * Shape a `ChatAssistReply` for the UI: stable ids + human-readable
 * kind labels. Pure — no React / no DOM.
 */
export function summariseChatAssist(reply: ChatAssistReply): ChatAssistDisplay {
  const suggestions: ChatAssistDisplaySuggestion[] = reply.suggestions.map(
    (s, idx) => ({
      id: `assist-${idx}-${s.kind}`,
      kind: s.kind,
      kindLabel: KIND_LABEL[s.kind],
      text: s.text,
      rationale: s.rationale,
    }),
  );
  return {
    summary: reply.summary,
    suggestions: Object.freeze(suggestions),
  };
}

/** Re-export the raw kind type for callers who want it. */
export type { ChatAssistSuggestion, ChatAssistReply, ChatAssistKind };

/**
 * Public handle the desktop view consumes. The orchestrator itself is
 * never accessed directly from the React layer — the wrapper just
 * calls `ask(query)` and reads the structured result.
 */
export interface ChatAssistHandle {
  readonly orchestrator: ChatAssistOrchestrator;
}