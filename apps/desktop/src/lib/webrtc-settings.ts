/**
 * WebRTC ICE server preferences (STUN/TURN URLs).
 *
 * Stored in localStorage for V0.1 — same pattern as other desktop
 * prefs that are not secrets. Empty / invalid input falls back to
 * the transport package defaults.
 */

import { DEFAULT_STUN_SERVERS } from '@kindora/transport';

const STORAGE_KEY = 'kindora.webrtc.iceServers';
const SIGNALLING_URL_KEY = 'kindora.webrtc.signallingUrl';

/** One URL per line in the Settings textarea. */
export function formatIceServers(urls: readonly string[]): string {
  return urls.join('\n');
}

/**
 * Parse a Settings textarea into validated ICE URLs.
 * Accepts `stun:` / `stuns:` / `turn:` / `turns:` only.
 */
export function parseIceServers(text: string): string[] {
  const lines = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    if (!isAllowedIceUrl(line)) {
      throw new Error(`Unsupported ICE URL (use stun:/turn: only): ${line}`);
    }
    out.push(line);
  }
  return out;
}

export function isAllowedIceUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.startsWith('stun:') ||
    lower.startsWith('stuns:') ||
    lower.startsWith('turn:') ||
    lower.startsWith('turns:')
  );
}

export function loadIceServers(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_STUN_SERVERS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...DEFAULT_STUN_SERVERS];
    }
    const urls = parsed.filter((u): u is string => typeof u === 'string' && isAllowedIceUrl(u));
    return urls.length > 0 ? urls : [...DEFAULT_STUN_SERVERS];
  } catch {
    return [...DEFAULT_STUN_SERVERS];
  }
}

export function saveIceServers(urls: readonly string[]): void {
  const cleaned = urls.filter(isAllowedIceUrl);
  if (cleaned.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
}

export function resetIceServers(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Mode C signalling base URL (e.g. `http://127.0.0.1:8787`). Empty = unset. */
export function loadSignallingUrl(): string {
  try {
    return (localStorage.getItem(SIGNALLING_URL_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function saveSignallingUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    localStorage.removeItem(SIGNALLING_URL_KEY);
    return;
  }
  localStorage.setItem(SIGNALLING_URL_KEY, trimmed);
}

export function resetSignallingUrl(): void {
  localStorage.removeItem(SIGNALLING_URL_KEY);
}
