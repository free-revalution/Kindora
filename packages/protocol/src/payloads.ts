/**
 * Per-message-type payload schemas for KSA 0.1.
 *
 * These are the *outward-facing* data shapes — the JSON body of each
 * envelope's `payload` field. Schema validation lives in `validation.ts`.
 *
 * See 开发手册.md § 21–22, Phase 4.
 */
import type { AgentCapabilities, MatchAnalysis, SocialAgent, SocialProfile } from './index';

/* ------------------------------------------------------------------ */
/* hello / profile_exchange — handshake                                */
/* ------------------------------------------------------------------ */

/** First message on a new connection. Each side announces itself. */
export interface HelloPayload {
  /** Stable display name shown in the peer list. */
  readonly displayName: string;
  /** The capabilities of this agent — drives feature negotiation. */
  readonly capabilities: AgentCapabilities;
  /** Optional short status message. */
  readonly status?: string;
}

/**
 * Sends the local profile + agent identity to the peer. Both sides
 * exchange one of these before any match analysis (§ 22).
 */
export interface ProfileExchangePayload {
  /** Full social profile of the sender. */
  readonly profile: SocialProfile;
  /** Public view of the sender's agent (publicKey included). */
  readonly agent: SocialAgent;
}

/* ------------------------------------------------------------------ */
/* match_request / match_response — local analysis handoff             */
/* Per § 23, each agent runs its OWN analysis. The peer only ships   */
/* back its own MatchAnalysis; it does NOT decide for the local user. */
/* ------------------------------------------------------------------ */

/** A asks B to perform local match analysis. */
export interface MatchRequestPayload {
  /**
   * Snapshot of A's profile at the time of the request, so B can run
   * analysis even if A's profile changed since profile_exchange.
   */
  readonly selfProfile: SocialProfile;
}

/** B returns its local MatchAnalysis. */
export interface MatchResponsePayload {
  readonly analysis: MatchAnalysis;
  /** B's display name, for logging / UI. */
  readonly displayName?: string;
}

/* ------------------------------------------------------------------ */
/* icebreaker_request / icebreaker_response                           */
/* Per Phase 8: AI generates topics; user picks, edits, or regenerates. */
/* ------------------------------------------------------------------ */

export interface IcebreakerRequestPayload {
  /** Optional hints — peer can use them to bias topic generation. */
  readonly topicHints?: readonly string[];
}

export interface IcebreakerResponsePayload {
  /** Concrete conversation openers the human can pick from. */
  readonly topics: readonly string[];
}

/* ------------------------------------------------------------------ */
/* chat_message — Phase 9 human-to-human                              */
/* ------------------------------------------------------------------ */

export interface ChatMessagePayload {
  /** Plain text. Length-bounded by the transport (see 开发手册 § 51). */
  readonly text: string;
}

/* ------------------------------------------------------------------ */
/* permission_request — Phase 7 human consent                         */
/* ------------------------------------------------------------------ */

export type PermissionKind = 'contact_exchange' | 'offline_meeting';

export interface PermissionRequestPayload {
  readonly permission: PermissionKind;
  readonly reason?: string;
}

/* ------------------------------------------------------------------ */
/* disconnect — always last                                            */
/* ------------------------------------------------------------------ */

export interface DisconnectPayload {
  readonly reason?: string;
}
