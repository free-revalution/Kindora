/**
 * @kindora/protocol
 *
 * KSA — Kindora Social Agent Protocol, version 0.1.
 *
 * Pure data shapes. No I/O, no runtime dependencies.
 * See 开发手册.md § 7–16, § 21.
 */

export const PROTOCOL_NAME = 'KSA';
export const PROTOCOL_VERSION = '0.1';

/**
 * All message types supported in KSA 0.1.
 * See 开发手册.md § 21.
 */
export const MESSAGE_TYPES = [
  'hello',
  'profile_exchange',
  'match_request',
  'match_response',
  'icebreaker_request',
  'icebreaker_response',
  'chat_message',
  'permission_request',
  'consent_accept',
  'consent_reject',
  'block',
  'disconnect',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/* ------------------------------------------------------------------ */
/* Social intent, conversation style, boundaries                       */
/* See 开发手册.md § 8–9.                                                */
/* ------------------------------------------------------------------ */

export const SOCIAL_INTENTS = [
  'similar_interests',
  'project_partner',
  'gaming_partner',
  'learning_partner',
  'technical_discussion',
  'long_term_friendship',
  'activity_partner',
] as const;

export type SocialIntent = (typeof SOCIAL_INTENTS)[number];

export const CONVERSATION_STYLES = ['casual', 'deep', 'technical', 'funny', 'quiet'] as const;

export type ConversationStyle = (typeof CONVERSATION_STYLES)[number];

/**
 * Privacy boundaries shared between two agents BEFORE profile exchange.
 *
 * Defaults from 开发手册.md § 9: agent conversation ON, everything else
 * conservative until the user explicitly opts in.
 */
export const DEFAULT_SOCIAL_BOUNDARIES: SocialBoundaries = Object.freeze({
  allowAgentConversation: true,
  allowContactExchange: false,
  allowOfflineMeeting: false,
  allowProjectDetails: false,
  allowCurrentActivity: true,
});

export interface SocialBoundaries {
  /** Peer agents may initiate conversation with this user. */
  allowAgentConversation: boolean;
  /** Peer may ask for / be given contact details (email, phone, etc.). */
  allowContactExchange: boolean;
  /** Peer may suggest meeting offline. */
  allowOfflineMeeting: boolean;
  /** Peer may receive project-level details (code, repos, customers). */
  allowProjectDetails: boolean;
  /** Peer may see the user's currentActivities field. */
  allowCurrentActivity: boolean;
}

/* ------------------------------------------------------------------ */
/* Public profile                                                      */
/* See 开发手册.md § 7.                                                  */
/* ------------------------------------------------------------------ */

export interface SocialProfile {
  nickname: string;
  avatar?: string;

  bio: string;

  interests: SocialIntent[] | string[];
  currentActivities: string[];

  socialIntent: SocialIntent[];
  conversationStyle: ConversationStyle[];

  boundaries: SocialBoundaries;
}

/* ------------------------------------------------------------------ */
/* Agent identity                                                      */
/* See 开发手册.md § 13–15.                                              */
/* ------------------------------------------------------------------ */

export interface AgentCapabilities {
  protocolVersion: string;

  supportsMatchAnalysis: boolean;
  supportsIcebreaker: boolean;
  supportsChatAssist: boolean;
  supportsEncryption: boolean;
}

export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  supportsMatchAnalysis: true,
  supportsIcebreaker: true,
  supportsChatAssist: true,
  supportsEncryption: true,
});

/**
 * The public-facing view of an agent. Private key is intentionally absent —
 * never sent over the wire. See 开发手册.md § 13.
 */
export interface SocialAgent {
  agentId: string;

  protocolVersion: string;

  displayName: string;

  publicKey: string;

  profile: SocialProfile;

  capabilities: AgentCapabilities;
}

/* ------------------------------------------------------------------ */
/* Match analysis — output of Phase 3 Agent Runtime.                  */
/* Carried in `match_response` messages in KSA Phase 4+.              */
/* See 开发手册.md § 6, Phase 3, Phase 6.                              */
/* ------------------------------------------------------------------ */

export const COMPATIBILITY_SIGNALS = ['strong', 'moderate', 'weak', 'none'] as const;

export type CompatibilitySignal = (typeof COMPATIBILITY_SIGNALS)[number];

export interface MatchAnalysis {
  /** Overall match strength. */
  readonly compatibilitySignal: CompatibilitySignal;

  /** Specific things the two humans likely share. */
  readonly commonGround: readonly string[];

  /** Concrete conversation topics for an opener. */
  readonly recommendedTopics: readonly string[];

  /** Honest things that could make the connection awkward. */
  readonly potentialFriction: readonly string[];

  /** Short human-readable explanation grounding the signal. */
  readonly explanation: string;
}

/* ------------------------------------------------------------------ */
/* Phase 4 — KSA envelope, payloads, builder, validation, anti-replay. */
/* See 开发手册.md § 20–22, § 50, § 53–54.                              */
/* ------------------------------------------------------------------ */

export {
  type KsaEnvelope,
  type KsaHello,
  type KsaProfileExchange,
  type KsaMatchRequest,
  type KsaMatchResponse,
  type KsaIcebreakerRequest,
  type KsaIcebreakerResponse,
  type KsaChatMessage,
  type KsaPermissionRequest,
  type KsaConsentAccept,
  type KsaConsentReject,
  type KsaBlock,
  type KsaDisconnect,
  type KsaMessage,
} from './envelope';

export {
  type HelloPayload,
  type ProfileExchangePayload,
  type MatchRequestPayload,
  type MatchResponsePayload,
  type IcebreakerRequestPayload,
  type IcebreakerResponsePayload,
  type ChatMessagePayload,
  type PermissionKind,
  type PermissionRequestPayload,
  type ConsentAcceptPayload,
  type ConsentRejectPayload,
  type BlockPayload,
  type DisconnectPayload,
} from './payloads';

export {
  generateMessageId,
  nowIso,
  type BuildEnvelopeOptions,
  createHello,
  createProfileExchange,
  createMatchRequest,
  createMatchResponse,
  createIcebreakerRequest,
  createIcebreakerResponse,
  createChatMessage,
  createPermissionRequest,
  createConsentAccept,
  createConsentReject,
  createBlock,
  createDisconnect,
} from './builder';

export { ProtocolValidationError, validateEnvelope, tryValidateEnvelope } from './validation';

export { ReplayGuard, ReplayRejected, type ReplayGuardOptions } from './replay-protection';

export {
  RateLimiter,
  rateLimiter,
  type RateLimiterOptions,
  type RateLimiterSnapshot,
} from './rate-limiter';

export {
  assertNoSensitiveFields,
  formatSensitiveFieldError,
  SensitiveFieldError,
  type SensitiveFieldGuardOptions,
} from './sensitive-field-guard';

export {
  sanitiseUntrustedText,
  sanitiseUntrustedPayload,
  UNTRUSTED_PLACEHOLDER,
  type SanitiseOptions,
} from './prompt-injection-guard';

export {
  jsonStringifyEnvelope,
  parseEnvelope,
  encodeEnvelope,
  decodeEnvelope,
} from './serialization';
