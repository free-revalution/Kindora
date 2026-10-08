import { describe, it, expect } from 'vitest';
import {
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  type MessageType,
} from '../index';

describe('@kindora/protocol', () => {
  it('exposes the KSA 0.1 protocol identity', () => {
    expect(PROTOCOL_NAME).toBe('KSA');
    expect(PROTOCOL_VERSION).toBe('0.1');
  });

  it('lists every V0.1 message type from 开发手册.md § 21', () => {
    const expected: MessageType[] = [
      'hello',
      'profile_exchange',
      'match_request',
      'match_response',
      'icebreaker_request',
      'icebreaker_response',
      'chat_message',
      'permission_request',
      'disconnect',
    ];
    expect([...MESSAGE_TYPES].sort()).toEqual([...expected].sort());
  });
});
