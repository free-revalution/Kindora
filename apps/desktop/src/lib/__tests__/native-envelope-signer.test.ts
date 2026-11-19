import { describe, it, expect } from 'vitest';
import { isNativeSigningAvailable } from '../native-envelope-signer';

describe('native-envelope-signer', () => {
  it('reports native signing unavailable in the Vitest (non-Tauri) runtime', () => {
    expect(isNativeSigningAvailable()).toBe(false);
  });
});
