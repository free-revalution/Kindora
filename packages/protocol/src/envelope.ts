/**
 * KSA envelope — the on-the-wire message shape.
 *
 * Per 开发手册.md § 20:
 *
 *   {
 *     "protocol": "KSA",
 *     "version": "0.1",
 *     "messageId": "uuid",
 *     "timestamp": "ISO-8601",
 *     "type": "...",
 *     "sender": "agent_id",
 *     "payload": { ... }
 *   }
 *
 * The envelope is a discriminated union on `type` — each variant
 * pins its `payload` to the matching schema in `payloads.ts`. This
 * means callers cannot accidentally read a `match_response` payload
 * as `chat_message`.
 *
 * The envelope shape is immutable: `createEnvelope` returns a frozen
 * object, and the validator rejects any mutation.
 */
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
import { PROTOCOL_NAME, PROTOCOL_VERSION, type MessageType } from './index';

/* Per-type envelope variants — discriminated union on `type`. */
export interface KsaEnvelope<T extends MessageType, P> {
  readonly protocol: typeof PROTOCOL_NAME;
  readonly version: typeof PROTOCOL_VERSION;
  readonly messageId: string;
  readonly timestamp: string;
  readonly type: T;
  readonly sender: string;
  readonly payload: P;
}

export type KsaHello = KsaEnvelope<'hello', HelloPayload>;
export type KsaProfileExchange = KsaEnvelope<'profile_exchange', ProfileExchangePayload>;
export type KsaMatchRequest = KsaEnvelope<'match_request', MatchRequestPayload>;
export type KsaMatchResponse = KsaEnvelope<'match_response', MatchResponsePayload>;
export type KsaIcebreakerRequest = KsaEnvelope<'icebreaker_request', IcebreakerRequestPayload>;
export type KsaIcebreakerResponse = KsaEnvelope<'icebreaker_response', IcebreakerResponsePayload>;
export type KsaChatMessage = KsaEnvelope<'chat_message', ChatMessagePayload>;
export type KsaPermissionRequest = KsaEnvelope<'permission_request', PermissionRequestPayload>;
export type KsaDisconnect = KsaEnvelope<'disconnect', DisconnectPayload>;

/**
 * Discriminated union over all KSA message variants. Use `type` to
 * narrow before reading `payload`.
 */
export type KsaMessage =
  | KsaHello
  | KsaProfileExchange
  | KsaMatchRequest
  | KsaMatchResponse
  | KsaIcebreakerRequest
  | KsaIcebreakerResponse
  | KsaChatMessage
  | KsaPermissionRequest
  | KsaDisconnect;
