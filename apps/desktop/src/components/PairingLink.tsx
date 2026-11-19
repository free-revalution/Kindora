/**
 * Pairing link — shows a scannable QR matrix for `kindora://pair?…`
 * plus a copyable URL. Zero npm dependencies (local `qr-matrix` encoder).
 */

import { useMemo, useState } from 'react';
import { encodeQrPayload } from '@kindora/transport';
import { PROTOCOL_VERSION } from '@kindora/protocol';
import { useTranslate } from '../i18n';
import { encodeQrMatrix } from '../lib/qr-matrix';

export interface PairingLinkProps {
  readonly code: string;
  readonly agentId: string;
}

export function PairingLink({ code, agentId }: PairingLinkProps) {
  const t = useTranslate();
  const [copied, setCopied] = useState(false);

  const url = useMemo(() => {
    try {
      return encodeQrPayload({
        code,
        agentId,
        protocolVersion: PROTOCOL_VERSION,
      });
    } catch {
      return null;
    }
  }, [code, agentId]);

  const matrix = useMemo(() => {
    if (!url) return null;
    try {
      return encodeQrMatrix(url);
    } catch {
      return null;
    }
  }, [url]);

  if (!url) return null;
  const pairUrl = url;
  const size = matrix?.length ?? 0;

  async function copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(pairUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be denied in tests */
    }
  }

  return (
    <div className="flex w-full flex-col items-center gap-3" data-testid="pairing-link">
      {matrix && (
        <svg
          width={Math.min(200, size * 4)}
          height={Math.min(200, size * 4)}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={t('connect.qrLabel')}
          className="rounded-sm bg-white p-2 shadow-sm"
          data-testid="pairing-qr"
        >
          {matrix.map((row, y) =>
            row.map((on, x) =>
              on ? (
                <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#141414" />
              ) : null,
            ),
          )}
        </svg>
      )}
      <div className="flex w-full items-center justify-between gap-2">
        <p className="text-kindora-500 dark:text-kindora-400 text-xs uppercase tracking-wide">
          {t('connect.pairUrl')}
        </p>
        <button
          type="button"
          className="kindora-button-ghost text-xs"
          onClick={() => void copyUrl()}
          data-testid="pairing-link-copy"
        >
          {copied ? t('connect.copied') : t('connect.copyPairUrl')}
        </button>
      </div>
      <p className="text-kindora-600 dark:text-kindora-300 w-full break-all font-mono text-[11px] leading-relaxed">
        {url}
      </p>
      <p className="text-kindora-500 dark:text-kindora-400 text-xs leading-relaxed">
        {t('connect.pairUrlHint')}
      </p>
    </div>
  );
}
