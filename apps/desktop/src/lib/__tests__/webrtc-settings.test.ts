import { describe, expect, it, beforeEach } from 'vitest';
import { DEFAULT_STUN_SERVERS } from '@kindora/transport';
import {
  formatIceServers,
  isAllowedIceUrl,
  loadIceServers,
  loadSignallingUrl,
  parseIceServers,
  resetIceServers,
  resetSignallingUrl,
  saveIceServers,
  saveSignallingUrl,
} from '../webrtc-settings';

describe('webrtc-settings', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the transport STUN list', () => {
    expect(loadIceServers()).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it('round-trips saved ICE URLs', () => {
    saveIceServers(['stun:example.com:3478', 'turn:relay.example.com:3478']);
    expect(loadIceServers()).toEqual([
      'stun:example.com:3478',
      'turn:relay.example.com:3478',
    ]);
  });

  it('parses and rejects bad ICE URLs', () => {
    expect(parseIceServers('stun:a\nturn:b')).toEqual(['stun:a', 'turn:b']);
    expect(() => parseIceServers('http://evil.example')).toThrow(/Unsupported ICE URL/);
  });

  it('formatIceServers joins with newlines', () => {
    expect(formatIceServers(['stun:a', 'stun:b'])).toBe('stun:a\nstun:b');
  });

  it('resetIceServers restores defaults', () => {
    saveIceServers(['stun:custom:1']);
    resetIceServers();
    expect(loadIceServers()).toEqual([...DEFAULT_STUN_SERVERS]);
  });

  it('isAllowedIceUrl accepts stun/turn schemes only', () => {
    expect(isAllowedIceUrl('stun:x')).toBe(true);
    expect(isAllowedIceUrl('stuns:x')).toBe(true);
    expect(isAllowedIceUrl('turn:x')).toBe(true);
    expect(isAllowedIceUrl('turns:x')).toBe(true);
    expect(isAllowedIceUrl('https://x')).toBe(false);
  });

  it('round-trips the Mode C signalling URL', () => {
    expect(loadSignallingUrl()).toBe('');
    saveSignallingUrl('http://127.0.0.1:8787/');
    expect(loadSignallingUrl()).toBe('http://127.0.0.1:8787');
    resetSignallingUrl();
    expect(loadSignallingUrl()).toBe('');
  });
});
