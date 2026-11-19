/**
 * P0-2A / A10 — host-side out-of-band confirmation of the joiner fingerprint (IBR-5).
 *
 * The joiner already typed the host fingerprint before sending `hello`.
 * The host must confirm the joiner's six-character fingerprint before
 * consent / chat (IBR-11). Comparison goes through Rust when available.
 */

import { useEffect, useState } from 'react';
import { formatPairingFingerprint, pairingFingerprintFromPublicKey } from '@kindora/transport';
import type { PeerIntroduction } from '@kindora/matching';
import { useTranslate } from '../i18n';
import {
  markPeerFingerprintVerified,
  type EnvelopeAuthState,
} from '../lib/authorized-envelope';
import { deriveLocalFingerprint } from '../lib/native-fingerprint';
import { sessionConfirmPeerFingerprint, sessionNotePeer } from '../lib/outbound-session';

export interface PeerFingerprintConfirmViewProps {
  readonly peer: PeerIntroduction;
  readonly envelopeAuth?: EnvelopeAuthState;
  readonly onConfirmed: () => void;
  readonly onDisconnect: () => void;
}

export function PeerFingerprintConfirmView({
  peer,
  envelopeAuth,
  onConfirmed,
  onDisconnect,
}: PeerFingerprintConfirmViewProps) {
  const t = useTranslate();
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const publicKey = peer.peerAgent?.publicKey;
      if (!publicKey) {
        if (!cancelled) setError(t('connect.peerFingerprintMissing'));
        return;
      }
      try {
        const fp = await deriveLocalFingerprint(peer.peerAgentId, publicKey);
        if (!cancelled) setFingerprint(fp);
      } catch {
        // Fall back to the pure-TS path when Tauri is unavailable.
        try {
          const fp = await pairingFingerprintFromPublicKey(peer.peerAgentId, publicKey);
          if (!cancelled) setFingerprint(fp);
        } catch (e: unknown) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peer, t]);

  async function confirm(): Promise<void> {
    if (!fingerprint) return;
    setBusy(true);
    setError(null);
    try {
      const publicKey = peer.peerAgent?.publicKey;
      if (publicKey) {
        await sessionNotePeer(peer.peerAgentId, publicKey);
      }
      // Rust compares claimed against the latched peer fingerprint.
      await sessionConfirmPeerFingerprint(fingerprint);
      if (envelopeAuth) {
        markPeerFingerprintVerified(envelopeAuth);
      }
      onConfirmed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const display = fingerprint ? formatPairingFingerprint(fingerprint) : '····-··';

  return (
    <main className="kindora-page items-center gap-4 py-16" data-testid="peer-fingerprint-confirm">
      <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
        {t('connect.peerFingerprintEyebrow')}
      </p>
      <h1 className="text-2xl font-semibold tracking-tight">{t('connect.peerFingerprintTitle')}</h1>
      <p className="text-kindora-500 dark:text-kindora-400 max-w-md text-center text-sm">
        {t('connect.peerFingerprintBody', { name: peer.peerDisplayName })}
      </p>
      <p
        className="font-mono text-5xl font-semibold tracking-[0.4em]"
        data-testid="peer-fingerprint-code"
      >
        {display}
      </p>
      {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          className="kindora-button"
          disabled={!fingerprint || busy}
          data-testid="peer-fingerprint-confirm-btn"
          onClick={() => void confirm()}
        >
          {busy ? t('connect.peerFingerprintConfirming') : t('connect.peerFingerprintConfirm')}
        </button>
        <button type="button" className="kindora-button-ghost" onClick={onDisconnect}>
          {t('common.cancel')}
        </button>
      </div>
      <p className="text-kindora-600 dark:text-kindora-300 max-w-md text-center text-xs leading-relaxed">
        {t('connect.peerFingerprintHint')}
      </p>
    </main>
  );
}
