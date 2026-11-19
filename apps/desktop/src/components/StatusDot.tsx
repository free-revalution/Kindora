export type StatusDotTone = 'idle' | 'live' | 'warn' | 'error' | 'busy';

const TONE: Record<StatusDotTone, string> = {
  idle: 'bg-kindora-300',
  live: 'bg-pastel-greenInk',
  warn: 'bg-pastel-yellowInk',
  error: 'bg-pastel-redInk',
  busy: 'bg-kindora-700 animate-pulse',
};

export function StatusDot({
  tone = 'idle',
  className = '',
  label,
}: {
  tone?: StatusDotTone;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${TONE[tone]} ${className}`}
      aria-label={label}
      title={label}
    />
  );
}
