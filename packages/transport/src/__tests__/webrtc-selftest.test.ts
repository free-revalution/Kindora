import { describe, expect, it } from 'vitest';
import { isWebRtcAvailable, runWebRtcLoopbackSelfTest } from '../index';

describe('runWebRtcLoopbackSelfTest', () => {
  it('reports unavailable when RTCPeerConnection is missing', async () => {
    if (isWebRtcAvailable()) {
      // Real browser / WebView — covered by the next case.
      return;
    }
    const result = await runWebRtcLoopbackSelfTest(2_000);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/RTCPeerConnection/i);
  });

  it('opens a local DataChannel pair when RTCPeerConnection exists', async () => {
    if (!isWebRtcAvailable()) {
      return;
    }
    const result = await runWebRtcLoopbackSelfTest(20_000);
    expect(result.ok).toBe(true);
  }, 25_000);
});
