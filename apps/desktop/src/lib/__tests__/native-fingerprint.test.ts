import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveLocalFingerprint,
  verifyPeerFingerprint,
  isNativeFingerprintAvailable,
} from '../native-fingerprint';

describe('native-fingerprint', () => {
  beforeEach(() => {
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === 'agent_local_fingerprint') {
          return 'RUST-FP';
        }
        if (cmd === 'agent_verify_peer_fingerprint') {
          return args.claimed === args.expected;
        }
        throw new Error(`unexpected invoke ${cmd}`);
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Rust invoke when Tauri is present', async () => {
    expect(isNativeFingerprintAvailable()).toBe(true);
    await expect(
      deriveLocalFingerprint('agent', 'cHVibGlj'),
    ).resolves.toBe('RUST-FP');
    await expect(verifyPeerFingerprint('ABCD', 'ABCD')).resolves.toBe(true);
  });
});