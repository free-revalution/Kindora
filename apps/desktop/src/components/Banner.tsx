import type { ReactNode } from 'react';

export type BannerTone = 'error' | 'warn' | 'info';

const TONE: Record<BannerTone, string> = {
  error: 'kindora-banner-error',
  warn: 'kindora-warning',
  info: 'kindora-banner-info',
};

export function Banner({
  tone = 'info',
  children,
  testId,
  onDismiss,
}: {
  tone?: BannerTone;
  children: ReactNode;
  testId?: string;
  onDismiss?: () => void;
}) {
  return (
    <div className={`${TONE[tone]} flex items-start justify-between gap-3`} data-testid={testId}>
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss && (
        <button
          type="button"
          className="shrink-0 text-xs opacity-70 hover:opacity-100"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}
