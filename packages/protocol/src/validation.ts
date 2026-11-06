/**
 * Schema validation for KSA envelopes (§ 53).
 *
 * Two-layer defence:
 *
 *   1. `validateEnvelope(envelope)` — checks the OUTER envelope
 *      (protocol, version, messageId, timestamp, sender, type) and
 *      picks the correct payload schema for the type.
 *
 *   2. Per-payload schema functions — assert the shape of the
 *      payload object for that message type. These are exported
 *      individually so a caller that has already narrowed by `type`
 *      can re-validate cheaply.
 *
 * The validator is pure / synchronous / throws on failure. The
 * transport layer is responsible for catching and turning failures
 * into `disconnect` events.
 *
 * See 开发手册.md § 50, § 53.
 */
import {
  COMPATIBILITY_SIGNALS,
  CONVERSATION_STYLES,
  DEFAULT_SOCIAL_BOUNDARIES,
  MESSAGE_TYPES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SOCIAL_INTENTS,
  type MessageType,
  type SocialBoundaries,
  type SocialProfile,
} from './index';
import type { KsaMessage } from './envelope';
import {
  ES256_SIGNATURE_BYTES,
  SHA256_BYTES,
  SIGNATURE_ALG,
  SIGNING_SCHEME,
  isBase64UrlOfLength,
  type KsaSignature,
} from './signature';
import type {
  BlockPayload,
  ChatMessagePayload,
  ConsentAcceptPayload,
  ConsentRejectPayload,
  DisconnectPayload,
  HelloPayload,
  IcebreakerRequestPayload,
  IcebreakerResponsePayload,
  MatchRequestPayload,
  MatchResponsePayload,
  PermissionRequestPayload,
  ProfileExchangePayload,
} from './payloads';

export class ProtocolValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolValidationError';
  }
}

/* UUID v4 regex — strict enough to reject garbage, lenient enough to
 * accept any version 4 UUID (we do not require a specific variant bit
 * pattern since some legacy implementations produced 0x80 or 0xb8x). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ISO-8601 with required 'T' separator and at least seconds precision.
 * Accepts the 'Z' suffix or a numeric offset like +08:00. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/;

const AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, field: string, max: number): string {
  const v = obj[field];
  if (typeof v !== 'string') {
    throw new ProtocolValidationError(field, 'not-string', `${field} must be a string.`);
  }
  if (v.length === 0) {
    throw new ProtocolValidationError(field, 'empty', `${field} must not be empty.`);
  }
  if (v.length > max) {
    throw new ProtocolValidationError(
      field,
      'too-long',
      `${field} exceeds ${max} characters (got ${v.length}).`,
    );
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  field: string,
  max: number,
): string | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new ProtocolValidationError(
      field,
      'not-string',
      `${field} must be a string when present.`,
    );
  }
  if (v.length > max) {
    throw new ProtocolValidationError(
      field,
      'too-long',
      `${field} exceeds ${max} characters (got ${v.length}).`,
    );
  }
  return v;
}

function requireBoolean(obj: Record<string, unknown>, field: string): boolean {
  const v = obj[field];
  if (typeof v !== 'boolean') {
    throw new ProtocolValidationError(field, 'not-boolean', `${field} must be a boolean.`);
  }
  return v;
}

/**
 * Read a boolean that a peer may not have sent yet.
 *
 * Phase A / A4: the security capability flags were added after KSA 0.1
 * shipped, so an older peer's `hello` simply does not carry them. A
 * missing flag means "this peer does not have the capability" — never
 * an error — which is what keeps the handshake forward compatible.
 */
function optionalBoolean(obj: Record<string, unknown>, field: string): boolean | undefined {
  const v = obj[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new ProtocolValidationError(
      field,
      'not-boolean',
      `${field} must be a boolean when present.`,
    );
  }
  return v;
}

function requireArrayOfStrings(
  obj: Record<string, unknown>,
  field: string,
  opts: { maxCount: number; maxItem: number },
): string[] {
  const v = obj[field];
  if (!Array.isArray(v)) {
    throw new ProtocolValidationError(field, 'not-array', `${field} must be an array.`);
  }
  if (v.length > opts.maxCount) {
    throw new ProtocolValidationError(
      field,
      'too-many',
      `${field} has more than ${opts.maxCount} items (got ${v.length}).`,
    );
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') {
      throw new ProtocolValidationError(
        field,
        'item-not-string',
        `${field}[] entries must be strings.`,
      );
    }
    if (item.length > opts.maxItem) {
      throw new ProtocolValidationError(
        field,
        'item-too-long',
        `${field}[] entry exceeds ${opts.maxItem} characters.`,
      );
    }
    out.push(item);
  }
  return out;
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const v = obj[field];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ProtocolValidationError(
      field,
      'not-in-enum',
      `${field} must be one of ${allowed.join(', ')}.`,
    );
  }
  return v as T;
}

/* ------------------------------------------------------------------ */
/* Per-payload schema validators                                      */
/* ------------------------------------------------------------------ */

function validateBoundaries(obj: Record<string, unknown>, path: string): SocialBoundaries {
  // (path kept for future error-message localisation)
  void path;
  const d = DEFAULT_SOCIAL_BOUNDARIES;
  return {
    allowAgentConversation: requireBoolean(obj, 'allowAgentConversation'),
    allowContactExchange: requireBoolean(obj, 'allowContactExchange'),
    allowOfflineMeeting: requireBoolean(obj, 'allowOfflineMeeting'),
    allowProjectDetails: requireBoolean(obj, 'allowProjectDetails'),
    allowCurrentActivity: requireBoolean(obj, 'allowCurrentActivity'),
    // Phase B: the field-level disclosure gates were added after KSA
    // 0.1 shipped, so a peer that predates them simply does not carry
    // them. A missing gate means "use the default" — never "allowed".
    // The default is `false` for the sensitive fields (bio / avatar /
    // currentActivities) and `true` for the ones the core flow needs.
    allowBio: optionalBoolean(obj, 'allowBio') ?? d.allowBio,
    allowInterests: optionalBoolean(obj, 'allowInterests') ?? d.allowInterests,
    allowAvatar: optionalBoolean(obj, 'allowAvatar') ?? d.allowAvatar,
    allowSocialIntent: optionalBoolean(obj, 'allowSocialIntent') ?? d.allowSocialIntent,
    allowConversationStyle:
      optionalBoolean(obj, 'allowConversationStyle') ?? d.allowConversationStyle,
  };
}

function validateSocialProfile(obj: Record<string, unknown>, path: string): SocialProfile {
  if (!isObject(obj)) {
    throw new ProtocolValidationError(path, 'not-object', `${path} must be an object.`);
  }
  const profile: SocialProfile = {
    nickname: requireString(obj, 'nickname', 64),
    // Phase B: `bio` may be empty (or absent). A profile whose fields
    // the user did not authorise is a **redacted** profile, and a
    // redacted profile must still be a legal profile — otherwise the
    // privacy filter would produce envelopes the peer throws away.
    // The "a bio is required" rule stays where it belongs: in the form
    // validator (`validateProfile` in @kindora/agent), which governs
    // the LOCAL profile, not the wire copy.
    bio: optionalString(obj, 'bio', 400) ?? '',
    interests: requireArrayOfStrings(obj, 'interests', { maxCount: 16, maxItem: 80 }),
    currentActivities: requireArrayOfStrings(obj, 'currentActivities', {
      maxCount: 16,
      maxItem: 80,
    }),
    socialIntent: requireArrayOfStrings(obj, 'socialIntent', { maxCount: 8, maxItem: 40 }).filter(
      (s) => (SOCIAL_INTENTS as readonly string[]).includes(s),
    ) as SocialProfile['socialIntent'],
    conversationStyle: requireArrayOfStrings(obj, 'conversationStyle', {
      maxCount: 4,
      maxItem: 20,
    }).filter((s) =>
      (CONVERSATION_STYLES as readonly string[]).includes(s),
    ) as SocialProfile['conversationStyle'],
    boundaries: validateBoundaries(
      isObject(obj.boundaries) ? (obj.boundaries as Record<string, unknown>) : {},
      `${path}.boundaries`,
    ),
  };
  // Phase B: the "at least one intent / one style" rule was **removed**
  // from the wire validator. It used to reject a redacted profile whose
  // user had switched the corresponding disclosure gate off — which
  // would have made the privacy filter break the protocol. It remains
  // enforced for the LOCAL profile by `validateProfile`
  // (@kindora/agent), so the user still cannot save an empty profile.
  return profile;
}

function validateHelloPayload(payload: unknown): HelloPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError('payload', 'not-object', 'hello payload must be an object.');
  }
  const exchange = isObject(payload.sessionKeyExchange)
    ? (payload.sessionKeyExchange as Record<string, unknown>)
    : undefined;
  return {
    displayName: requireString(payload, 'displayName', 64),
    capabilities: validateCapabilities(
      isObject(payload.capabilities) ? (payload.capabilities as Record<string, unknown>) : {},
      'payload.capabilities',
    ),
    status: optionalString(payload, 'status', 280),
    // The identity public key travels in `hello` so the peer can verify
    // this message's signature. Standard base64, SPKI DER.
    publicKey: optionalString(payload, 'publicKey', 1024),
    sessionKeyExchange: exchange
      ? {
          ephemeralPublicKey: requireString(exchange, 'ephemeralPublicKey', 1024),
          keyId: requireString(exchange, 'keyId', 128),
        }
      : undefined,
  };
}

/**
 * Validate the capability block.
 *
 * The three functional flags are mandatory. The four security flags
 * (Phase A / A4) are optional and default to `false` so that a peer
 * which predates them still parses — and so that "did not advertise it"
 * can never be mistaken for "advertised it".
 */
function validateCapabilities(
  obj: Record<string, unknown>,
  path: string,
): HelloPayload['capabilities'] {
  // (path kept for future error-message localisation)
  void path;
  return {
    protocolVersion: requireString(obj, 'protocolVersion', 8),
    supportsMatchAnalysis: requireBoolean(obj, 'supportsMatchAnalysis'),
    supportsIcebreaker: requireBoolean(obj, 'supportsIcebreaker'),
    supportsChatAssist: requireBoolean(obj, 'supportsChatAssist'),
    supportsMessageSigning: optionalBoolean(obj, 'supportsMessageSigning') ?? false,
    supportsSessionEncryption: optionalBoolean(obj, 'supportsSessionEncryption') ?? false,
    supportsTransportEncryption: optionalBoolean(obj, 'supportsTransportEncryption') ?? false,
    supportsWebRtc: optionalBoolean(obj, 'supportsWebRtc') ?? false,
  };
}

function validateProfileExchangePayload(payload: unknown): ProfileExchangePayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'profile_exchange payload must be an object.',
    );
  }
  const agentObj = isObject(payload.agent) ? (payload.agent as Record<string, unknown>) : {};
  const profile = validateSocialProfile(
    isObject(payload.profile) ? (payload.profile as Record<string, unknown>) : {},
    'payload.profile',
  );
  return {
    profile,
    agent: {
      agentId: requireString(agentObj, 'agentId', 64),
      protocolVersion: requireString(agentObj, 'protocolVersion', 8),
      displayName: requireString(agentObj, 'displayName', 64),
      publicKey: requireString(agentObj, 'publicKey', 1024),
      profile,
      capabilities: validateCapabilities(
        isObject(agentObj.capabilities) ? (agentObj.capabilities as Record<string, unknown>) : {},
        'payload.agent.capabilities',
      ),
    },
  };
}

function validateMatchRequestPayload(payload: unknown): MatchRequestPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'match_request payload must be an object.',
    );
  }
  return {
    selfProfile: validateSocialProfile(
      isObject(payload.selfProfile) ? (payload.selfProfile as Record<string, unknown>) : {},
      'payload.selfProfile',
    ),
  };
}

function validateMatchResponsePayload(payload: unknown): MatchResponsePayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'match_response payload must be an object.',
    );
  }
  const analysisObj = isObject(payload.analysis)
    ? (payload.analysis as Record<string, unknown>)
    : {};
  return {
    analysis: {
      compatibilitySignal: requireEnum(analysisObj, 'compatibilitySignal', COMPATIBILITY_SIGNALS),
      commonGround: requireArrayOfStrings(analysisObj, 'commonGround', {
        maxCount: 8,
        maxItem: 200,
      }),
      recommendedTopics: requireArrayOfStrings(analysisObj, 'recommendedTopics', {
        maxCount: 8,
        maxItem: 200,
      }),
      potentialFriction: requireArrayOfStrings(analysisObj, 'potentialFriction', {
        maxCount: 8,
        maxItem: 200,
      }),
      explanation: requireString(analysisObj, 'explanation', 600),
    },
    displayName: optionalString(payload, 'displayName', 64),
  };
}

function validateIcebreakerRequestPayload(payload: unknown): IcebreakerRequestPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'icebreaker_request payload must be an object.',
    );
  }
  return {
    topicHints:
      payload.topicHints === undefined
        ? undefined
        : requireArrayOfStrings(payload, 'topicHints', { maxCount: 8, maxItem: 80 }),
  };
}

function validateIcebreakerResponsePayload(payload: unknown): IcebreakerResponsePayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'icebreaker_response payload must be an object.',
    );
  }
  return {
    topics: requireArrayOfStrings(payload, 'topics', { maxCount: 8, maxItem: 200 }),
  };
}

function validateChatMessagePayload(payload: unknown): ChatMessagePayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'chat_message payload must be an object.',
    );
  }
  return { text: requireString(payload, 'text', 2000) };
}

function validatePermissionRequestPayload(payload: unknown): PermissionRequestPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'permission_request payload must be an object.',
    );
  }
  return {
    permission: requireEnum(payload, 'permission', ['contact_exchange', 'offline_meeting']),
    reason: optionalString(payload, 'reason', 280),
  };
}

function validateConsentAcceptPayload(payload: unknown): ConsentAcceptPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'consent_accept payload must be an object.',
    );
  }
  return { note: optionalString(payload, 'note', 280) };
}

function validateConsentRejectPayload(payload: unknown): ConsentRejectPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'consent_reject payload must be an object.',
    );
  }
  return { reason: optionalString(payload, 'reason', 280) };
}

function validateBlockPayload(payload: unknown): BlockPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError('payload', 'not-object', 'block payload must be an object.');
  }
  return { reason: optionalString(payload, 'reason', 280) };
}

function validateDisconnectPayload(payload: unknown): DisconnectPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError(
      'payload',
      'not-object',
      'disconnect payload must be an object.',
    );
  }
  return { reason: optionalString(payload, 'reason', 280) };
}

const PAYLOAD_VALIDATORS = {
  hello: validateHelloPayload,
  profile_exchange: validateProfileExchangePayload,
  match_request: validateMatchRequestPayload,
  match_response: validateMatchResponsePayload,
  icebreaker_request: validateIcebreakerRequestPayload,
  icebreaker_response: validateIcebreakerResponsePayload,
  chat_message: validateChatMessagePayload,
  permission_request: validatePermissionRequestPayload,
  consent_accept: validateConsentAcceptPayload,
  consent_reject: validateConsentRejectPayload,
  block: validateBlockPayload,
  disconnect: validateDisconnectPayload,
} as const satisfies { [K in MessageType]: (p: unknown) => unknown };

/* ------------------------------------------------------------------ */
/* Envelope validator                                                  */
/* ------------------------------------------------------------------ */

/** Validate an unknown value as a KSA envelope. Throws on failure. */
export function validateEnvelope(value: unknown): KsaMessage {
  if (!isObject(value)) {
    throw new ProtocolValidationError('envelope', 'not-object', 'Envelope must be an object.');
  }

  if (value.protocol !== PROTOCOL_NAME) {
    throw new ProtocolValidationError(
      'protocol',
      'wrong-protocol',
      `Envelope protocol must be "${PROTOCOL_NAME}" (got ${JSON.stringify(value.protocol)}).`,
    );
  }
  if (value.version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError(
      'version',
      'wrong-version',
      `Envelope version must be "${PROTOCOL_VERSION}" (got ${JSON.stringify(value.version)}).`,
    );
  }

  const messageId = requireString(value, 'messageId', 64);
  if (!UUID_V4.test(messageId)) {
    throw new ProtocolValidationError(
      'messageId',
      'not-uuid-v4',
      'messageId must be a valid UUID v4.',
    );
  }

  const timestamp = requireString(value, 'timestamp', 40);
  if (!ISO_8601.test(timestamp)) {
    throw new ProtocolValidationError(
      'timestamp',
      'not-iso8601',
      'timestamp must be an ISO-8601 datetime.',
    );
  }

  const sender = requireString(value, 'sender', 64);
  if (!AGENT_ID.test(sender)) {
    throw new ProtocolValidationError('sender', 'not-uuid', 'sender must be a UUID (agent id).');
  }

  const type = requireEnum(value, 'type', MESSAGE_TYPES);
  if (!('payload' in value)) {
    throw new ProtocolValidationError('payload', 'missing', 'Envelope is missing a payload field.');
  }

  const validator = PAYLOAD_VALIDATORS[type];
  const payload = validator(value.payload);

  // Phase A / A2: the signature is a top-level field and MUST survive
  // validation — before this change the re-assembly below dropped every
  // field it did not know about, which would have silently discarded
  // the signature of every signed message.
  const signature = validateSignature(value);

  // Re-assemble with the validated payload. Cast through `unknown`
  // because TS cannot prove the validator returned the exact right
  // variant — but every validator above enforces the contract.
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId,
    timestamp,
    type,
    sender,
    payload,
    ...(signature ? { signature } : {}),
  } as KsaMessage;
}

/**
 * Validate the detached signature block (Phase A / A2).
 *
 * Returns `undefined` when the envelope carries no signature — a peer
 * that predates signing still parses. The *presence* of a signature on
 * a protected message is checked by the transport, not here: the
 * validator only proves the block is well formed, never that it is
 * correct.
 */
function validateSignature(obj: Record<string, unknown>): KsaSignature | undefined {
  const raw = obj.signature;
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw)) {
    throw new ProtocolValidationError(
      'signature',
      'not-object',
      'signature must be an object when present.',
    );
  }

  const alg = requireString(raw, 'alg', 16);
  if (alg !== SIGNATURE_ALG) {
    throw new ProtocolValidationError(
      'signature',
      'unknown-alg',
      `signature.alg must be "${SIGNATURE_ALG}" (got ${JSON.stringify(alg)}).`,
    );
  }

  const signedFields = requireString(raw, 'signedFields', 32);
  if (signedFields !== SIGNING_SCHEME) {
    throw new ProtocolValidationError(
      'signature',
      'unknown-scheme',
      `signature.signedFields must be "${SIGNING_SCHEME}" (got ${JSON.stringify(signedFields)}).`,
    );
  }

  const keyId = requireString(raw, 'keyId', 128);
  if (!isBase64UrlOfLength(keyId, SHA256_BYTES)) {
    throw new ProtocolValidationError(
      'signature',
      'bad-key-id',
      'signature.keyId must be base64url of a 32-byte SHA-256 digest.',
    );
  }

  const value = requireString(raw, 'value', 256);
  if (!isBase64UrlOfLength(value, ES256_SIGNATURE_BYTES)) {
    throw new ProtocolValidationError(
      'signature',
      'bad-value',
      'signature.value must be base64url of a 64-byte ES256 signature.',
    );
  }

  return { alg, keyId, value, signedFields };
}

/**
 * Non-throwing variant. Returns either the validated envelope or an
 * error describing the first failure.
 */
export function tryValidateEnvelope(
  value: unknown,
): { ok: true; envelope: KsaMessage } | { ok: false; error: ProtocolValidationError } {
  try {
    return { ok: true, envelope: validateEnvelope(value) };
  } catch (err) {
    if (err instanceof ProtocolValidationError) {
      return { ok: false, error: err };
    }
    throw err;
  }
}
