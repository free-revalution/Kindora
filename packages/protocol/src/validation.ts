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
  MESSAGE_TYPES,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  SOCIAL_INTENTS,
  type MessageType,
  type SocialBoundaries,
  type SocialProfile,
} from './index';
import type { KsaMessage } from './envelope';
import type {
  ChatMessagePayload,
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
  return {
    allowAgentConversation: requireBoolean(obj, 'allowAgentConversation'),
    allowContactExchange: requireBoolean(obj, 'allowContactExchange'),
    allowOfflineMeeting: requireBoolean(obj, 'allowOfflineMeeting'),
    allowProjectDetails: requireBoolean(obj, 'allowProjectDetails'),
    allowCurrentActivity: requireBoolean(obj, 'allowCurrentActivity'),
  };
  // (path kept for future error-message localisation)
  void path;
}

function validateSocialProfile(obj: Record<string, unknown>, path: string): SocialProfile {
  if (!isObject(obj)) {
    throw new ProtocolValidationError(path, 'not-object', `${path} must be an object.`);
  }
  const profile: SocialProfile = {
    nickname: requireString(obj, 'nickname', 64),
    bio: requireString(obj, 'bio', 400),
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
  if (profile.socialIntent.length === 0) {
    throw new ProtocolValidationError(
      'socialIntent',
      'empty',
      `${path}.socialIntent must contain at least one valid intent.`,
    );
  }
  if (profile.conversationStyle.length === 0) {
    throw new ProtocolValidationError(
      'conversationStyle',
      'empty',
      `${path}.conversationStyle must contain at least one valid style.`,
    );
  }
  return profile;
}

function validateHelloPayload(payload: unknown): HelloPayload {
  if (!isObject(payload)) {
    throw new ProtocolValidationError('payload', 'not-object', 'hello payload must be an object.');
  }
  return {
    displayName: requireString(payload, 'displayName', 64),
    capabilities: validateCapabilities(
      isObject(payload.capabilities) ? (payload.capabilities as Record<string, unknown>) : {},
      'payload.capabilities',
    ),
    status: optionalString(payload, 'status', 280),
  };
}

function validateCapabilities(
  obj: Record<string, unknown>,
  path: string,
): HelloPayload['capabilities'] {
  return {
    protocolVersion: requireString(obj, 'protocolVersion', 8),
    supportsMatchAnalysis: requireBoolean(obj, 'supportsMatchAnalysis'),
    supportsIcebreaker: requireBoolean(obj, 'supportsIcebreaker'),
    supportsChatAssist: requireBoolean(obj, 'supportsChatAssist'),
    supportsEncryption: requireBoolean(obj, 'supportsEncryption'),
  };
  void path;
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
  } as KsaMessage;
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
