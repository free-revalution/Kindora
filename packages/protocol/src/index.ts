/**
 * @kindora/protocol
 *
 * KSA — Kindora Social Agent Protocol, version 0.1.
 *
 * This package defines the wire format that two Kindora clients use
 * to exchange public profile data and run a bounded matching conversation.
 * It has no runtime dependencies and no I/O — pure data shapes + validation.
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
  'disconnect',
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
