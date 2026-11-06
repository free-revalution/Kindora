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
 *
 * Phase B (2026-11-05): the defaults were re-derived from the
 * "最小必要授权原则" (task book § 五 B1 requirement 7). The previous
 * value of `allowCurrentActivity` was `true`, which contradicted this
 * very comment ("everything else conservative"). Now:
 *
 *   - `allowInterests` is ON — without it there is no common ground to
 *     match on and the whole product has nothing to do.
 *   - `allowBio`, `allowCurrentActivity`, `allowAvatar` are OFF — these
 *     are the classic over-shares (self-description, "what I am doing
 *     right now", a photo) and nothing in the core flow needs them.
 *   - `allowSocialIntent` / `allowConversationStyle` are ON — they are
 *     exactly what the consent screen shows the peer. An empty consent
 *     screen is not a consent screen. **This is the one place where the
 *     defaults are deliberately NOT minimal-necessary**; it is recorded
 *     as the open item **B-5** (the user may still want them off).
 *
 * The behavioural flags (conversation / contact / offline meeting /
 * project details) are all OFF except `allowAgentConversation`, which
 * has to stay ON or the product cannot function at all.
 */
export const DEFAULT_SOCIAL_BOUNDARIES: SocialBoundaries = Object.freeze({
  allowAgentConversation: true,
  allowContactExchange: false,
  allowOfflineMeeting: false,
  allowProjectDetails: false,
  allowCurrentActivity: false,
  allowBio: false,
  allowInterests: true,
  allowAvatar: false,
  allowSocialIntent: true,
  allowConversationStyle: true,
});

export interface SocialBoundaries {
  /* ---- behavioural permissions ---------------------------------- */

  /** Peer agents may initiate conversation with this user. */
  allowAgentConversation: boolean;
  /** Peer may ask for / be given contact details (email, phone, etc.). */
  allowContactExchange: boolean;
  /** Peer may suggest meeting offline. */
  allowOfflineMeeting: boolean;
  /** Peer may receive project-level details (code, repos, customers). */
  allowProjectDetails: boolean;

  /* ---- field-level disclosure gates (Phase B) -------------------- */

  /** Peer may see the user's currentActivities field. */
  allowCurrentActivity: boolean;
  /** Peer may see the user's bio (free-text self-description). */
  allowBio?: boolean;
  /** Peer may see the user's interests list. */
  allowInterests?: boolean;
  /** Peer may see the user's avatar. */
  allowAvatar?: boolean;
  /** Peer may see which social intents the user is looking for. */
  allowSocialIntent?: boolean;
  /** Peer may see which conversation styles the user prefers. */
  allowConversationStyle?: boolean;
}

/* ------------------------------------------------------------------ */
/* Public profile                                                      */
/* See 开发手册.md § 7.                                                  */
/* ------------------------------------------------------------------ */

export interface SocialProfile {
  nickname: string;
  avatar?: string;

  bio: string;

  /**
   * Free-form interest tags the user typed — "typescript", "reading".
   *
   * Phase H (2026-11-06): this used to be `SocialIntent[] | string[]`,
   * a union of two array types. Nothing ever put a `SocialIntent` in
   * here — the intents live in `socialIntent` below — and the wire
   * validator (`requireArrayOfStrings`) has always produced `string[]`.
   * The union was pure noise, and worse: TypeScript cannot resolve a
   * mutating method such as `push` on `A[] | B[]`, so any caller that
   * legitimately pushed onto the outbound copy failed to compile.
   *
   * Narrowing it to `string[]` accepts exactly the same values as
   * before (`SocialIntent` is a subtype of `string`), so no assignment
   * site changes meaning.
   */
  interests: string[];
  currentActivities: string[];

  socialIntent: SocialIntent[];
  conversationStyle: ConversationStyle[];

  boundaries: SocialBoundaries;
}

/* ------------------------------------------------------------------ */
/* Agent identity                                                      */
/* See 开发手册.md § 13–15.                                              */
/* ------------------------------------------------------------------ */

/**
 * What an agent is able to do.
 *
 * Phase A / A4 split the old, ambiguous `supportsEncryption` flag into
 * four flags that cannot be confused with one another:
 *
 *   - `supportsMessageSigning`     — can sign envelopes (ES256) and be verified
 *   - `supportsSessionEncryption`  — can take part in an end-to-end encrypted session
 *   - `supportsTransportEncryption` — the *transport* has TLS
 *   - `supportsWebRtc`             — can use a WebRTC DataChannel
 *
 * `supportsTransportEncryption` and `supportsWebRtc` are **false in KSA
 * 0.1**: there is no TLS on the LAN transport and the WebRTC transport
 * is not implemented (see Phase G). Declaring them true would be
 * exactly the "claiming a capability we do not have" bug this type
 * exists to prevent.
 *
 * Every flag must reflect the *actual runtime configuration* — see
 * `buildRuntimeCapabilities` in `@kindora/agent`.
 */
export interface AgentCapabilities {
  readonly protocolVersion: string;

  readonly supportsMatchAnalysis: boolean;
  readonly supportsIcebreaker: boolean;
  readonly supportsChatAssist: boolean;

  /** Can produce and verify ES256 envelope signatures. */
  readonly supportsMessageSigning: boolean;
  /** Can take part in an end-to-end encrypted session (ECDH + HKDF + AES-GCM). */
  readonly supportsSessionEncryption: boolean;
  /** The transport itself is protected by TLS. False in KSA 0.1. */
  readonly supportsTransportEncryption: boolean;
  /** Can use a WebRTC DataChannel. False in KSA 0.1. */
  readonly supportsWebRtc: boolean;
}

/**
 * The conservative baseline: what an agent can do with no crypto
 * configured at all.
 *
 * Note the three security flags are all `false` — an agent must opt in
 * by computing its capabilities from the real runtime configuration.
 */
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  supportsMatchAnalysis: true,
  supportsIcebreaker: true,
  supportsChatAssist: true,
  supportsMessageSigning: false,
  supportsSessionEncryption: false,
  supportsTransportEncryption: false,
  supportsWebRtc: false,
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
  type KsaSignature,
  type SignableEnvelope,
  type EnvelopeSigner,
  type EnvelopeVerifier,
  type SignEnvelopeParams,
  type VerifyEnvelopeParams,
  SIGNATURE_ALG,
  SIGNING_SCHEME,
  SIGNING_INPUT_HEADER,
  ES256_SIGNATURE_BYTES,
  SHA256_BYTES,
  buildSigningInput,
  signEnvelope,
  verifyEnvelopeSignature,
  isBase64UrlOfLength,
} from './signature';

export { canonicalize, canonicalizeToBytes, CanonicalJsonError } from './canonical-json';

export { bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes } from './base64';

export {
  KSA_CURVE,
  KSA_SIGNATURE_ALG,
  CryptoUnavailableError,
  getCrypto,
  isCryptoAvailable,
  sha256,
  hmacSha256,
  hkdfSha256,
  importPublicKey,
  importPrivateKey,
  signEs256,
  verifyEs256,
  deriveKeyId,
  generateEphemeralKeyPair,
  importEphemeralPublicKey,
  deriveSharedSecret,
  type EphemeralKeyPair,
} from './crypto';

export {
  type HelloPayload,
  type SessionKeyExchange,
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

/* Phase B — the profile privacy filter (task book § 五 B2). */
export {
  PROFILE_FIELD_RULES,
  ProfilePrivacyError,
  assertProfileWithinBoundaries,
  buildPublicCard,
  filterProfileForOutbound,
  isFieldAllowed,
  isFieldAllowedInPublicCard,
  redactedFields,
  resolveBoundaries,
  type ProfileField,
  type ProfileFieldRule,
} from './profile-privacy-filter';

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
  type SensitiveFieldReason,
} from './sensitive-field-guard';

export {
  sanitiseUntrustedText,
  sanitiseUntrustedTextDetailed,
  sanitiseUntrustedPayload,
  sanitiseUntrustedPayloadDetailed,
  buildUntrustedBlock,
  renderUntrustedBlock,
  UNTRUSTED_PLACEHOLDER,
  UNTRUSTED_DROPPED,
  UNTRUSTED_BLOCK_MARKER,
  UNTRUSTED_BLOCK_WARNING,
  type SanitiseOptions,
  type SanitiseTextResult,
  type UntrustedPayloadReport,
  type UntrustedBlock,
  type RenderUntrustedBlockOptions,
} from './prompt-injection-guard';

export {
  jsonStringifyEnvelope,
  parseEnvelope,
  encodeEnvelope,
  decodeEnvelope,
} from './serialization';
