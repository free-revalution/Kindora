/**
 * QR payload — encodes / decodes the URL a peer scans to join a pair.
 *
 * Wire format (encoded into a QR Code as one URL string):
 *
 *   kindora://pair?c=<PAIRING_CODE>&a=<AGENT_ID>&v=0.1
 *
 *   c : uppercase pairing code (6 chars typical)
 *   a : the host's agent UUID
 *   v : protocol version (currently 0.1)
 *
 * Why a custom URL scheme? It is unambiguous, future-proof (we can
 * grow the param set without colliding with `https://`), and short
 * enough to fit comfortably in a Version 4–5 QR.
 *
 * See 开发手册.md § 17.
 */

import { normalisePairingCode, isValidPairingCodeShape } from './pairing-code';

const QR_SCHEME = 'kindora://pair';

export interface QrPayload {
  /** Normalised (uppercase) pairing code. */
  readonly code: string;
  /** Host agent UUID. */
  readonly agentId: string;
  /** Protocol version of the host's implementation. */
  readonly protocolVersion: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encode a pairing payload as a URL string suitable for a QR Code. */
export function encodeQrPayload(payload: QrPayload): string {
  if (!isValidPairingCodeShape(payload.code)) {
    throw new Error('QrPayload.code is not a valid pairing code shape.');
  }
  if (!UUID_RE.test(payload.agentId)) {
    throw new Error('QrPayload.agentId must be a UUID.');
  }
  const code = normalisePairingCode(payload.code) ?? payload.code;
  return `${QR_SCHEME}?c=${encodeURIComponent(code)}&a=${encodeURIComponent(
    payload.agentId,
  )}&v=${encodeURIComponent(payload.protocolVersion)}`;
}

/**
 * Decode a scanned URL string into a QrPayload, or null if it does not
 * look like a Kindora pair URL. Unknown query params are ignored, so
 * the format can grow over time without breaking older clients.
 */
export function decodeQrPayload(text: string): QrPayload | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${QR_SCHEME}?`)) return null;
  const query = trimmed.slice(QR_SCHEME.length + 1);
  const params = new URLSearchParams(query);

  const code = params.get('c');
  const agentId = params.get('a');
  const version = params.get('v');
  if (!code || !agentId || !version) return null;

  const normalised = normalisePairingCode(code);
  if (!normalised) return null;
  if (!UUID_RE.test(agentId)) return null;

  return {
    code: normalised,
    agentId: agentId.toLowerCase(),
    protocolVersion: version,
  };
}

/** Predicate — true iff the string looks like a Kindora pair URL. */
export function isKindoraPairUrl(text: string): boolean {
  return typeof text === 'string' && text.trim().startsWith(`${QR_SCHEME}?`);
}
