/**
 * In-process WebRTC self-test — pairs two ManualSignallingAdapters via
 * `bridgeManualSignalling` and opens a DataChannel when
 * `RTCPeerConnection` exists (Tauri WebView / modern browsers).
 *
 * Used for single-machine verification; unit tests with mocks cover
 * the same paths in jsdom.
 */

import { bridgeManualSignalling, ManualSignallingAdapter } from './manual-signalling';
import { isWebRtcAvailable, WebRtcTransport } from './webrtc-transport';
import type { PeerInfo } from './index';

export interface WebRtcSelfTestResult {
  readonly ok: boolean;
  readonly detail: string;
}

const PEER_A: PeerInfo = { agentId: 'selftest-a', displayName: 'A' };
const PEER_B: PeerInfo = { agentId: 'selftest-b', displayName: 'B' };

/**
 * Attempt a local offer/answer round-trip. Resolves with `{ ok: true }`
 * when both DataChannels open; otherwise `{ ok: false, detail }`.
 */
export async function runWebRtcLoopbackSelfTest(
  timeoutMs = 15_000,
): Promise<WebRtcSelfTestResult> {
  if (!isWebRtcAvailable()) {
    return {
      ok: false,
      detail: 'RTCPeerConnection is not available in this runtime.',
    };
  }

  const offerSig = new ManualSignallingAdapter('offer');
  const answerSig = new ManualSignallingAdapter('answer');
  const unbridge = bridgeManualSignalling(offerSig, answerSig);

  // Self-test uses package defaults; the desktop app can still pass
  // custom ICE servers on real pairing via WebRtcTransport options.
  const offer = new WebRtcTransport({
    role: 'offer',
    signalling: offerSig,
    connectTimeoutMs: timeoutMs,
  });
  const answer = new WebRtcTransport({
    role: 'answer',
    signalling: answerSig,
    connectTimeoutMs: timeoutMs,
  });

  try {
    await Promise.all([offer.connect(PEER_A), answer.connect(PEER_B)]);
    if (!offer.isConnected() || !answer.isConnected()) {
      return { ok: false, detail: 'DataChannel did not report open on both sides.' };
    }
    return { ok: true, detail: 'Local WebRTC DataChannel pair opened.' };
  } catch (err: unknown) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    unbridge();
    await offer.disconnect().catch(() => undefined);
    await answer.disconnect().catch(() => undefined);
  }
}
