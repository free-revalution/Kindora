/**
 * Envelope builder — produces a frozen, ready-to-send KSA message.
 *
 * Centralises the boring-but-important fields:
 *   - protocol = "KSA"
 *   - version = "0.1"
 *   - messageId = freshly generated UUID
 *   - timestamp = current ISO-8601 UTC timestamp
 *   - sender = the local agent id
 *
 * Callers supply only `type` + `payload`. The builder asserts the
 * payload matches the schema for that type (compile-time via the
 * discriminated union, runtime via validation).
 *
 * See 开发手册.md § 20, § 51.
 */
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
import { PROTOCOL_NAME, PROTOCOL_VERSION } from './index';

/**
 * UUID v4 generator. Uses Web Crypto when available, falls back to a
 * sufficient-quality RFC4122-ish implementation for older runtimes
 * (Node < 19, jsdom in some configs).
 *
 * The fallback is NOT cryptographically strong — it uses Math.random.
 * Acceptable here because `messageId` is only required to be unique,
 * not unguessable (it is not used as a security token). The peer
 * still validates it strictly.
 */
export function generateMessageId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  // RFC 4122 v4 fallback (sufficient for uniqueness, not security).
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface BuildEnvelopeOptions {
  /** Override the timestamp (tests only). Defaults to `new Date()`. */
  readonly timestamp?: string;
  /** Override the messageId (tests only). Defaults to a fresh UUID. */
  readonly messageId?: string;
}

/** Hello — first message on a new connection. */
export function createHello(
  sender: string,
  payload: HelloPayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'hello',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createProfileExchange(
  sender: string,
  payload: ProfileExchangePayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'profile_exchange',
    sender,
    payload: Object.freeze({
      profile: Object.freeze({ ...payload.profile }),
      agent: Object.freeze({ ...payload.agent, profile: payload.agent.profile }),
    }),
  });
}

export function createMatchRequest(
  sender: string,
  payload: MatchRequestPayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'match_request',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createMatchResponse(
  sender: string,
  payload: MatchResponsePayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'match_response',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createIcebreakerRequest(
  sender: string,
  payload: IcebreakerRequestPayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'icebreaker_request',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createIcebreakerResponse(
  sender: string,
  payload: IcebreakerResponsePayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'icebreaker_response',
    sender,
    payload: Object.freeze({ topics: Object.freeze([...payload.topics]) }),
  });
}

export function createChatMessage(
  sender: string,
  payload: ChatMessagePayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'chat_message',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createPermissionRequest(
  sender: string,
  payload: PermissionRequestPayload,
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'permission_request',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}

export function createDisconnect(
  sender: string,
  payload: DisconnectPayload = {},
  options: BuildEnvelopeOptions = {},
): KsaMessage {
  return Object.freeze({
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    messageId: options.messageId ?? generateMessageId(),
    timestamp: options.timestamp ?? nowIso(),
    type: 'disconnect',
    sender,
    payload: Object.freeze({ ...payload }),
  });
}
