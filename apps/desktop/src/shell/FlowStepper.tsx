import { useTranslate, type Translate } from '../i18n';
import { FLOW_STEPS, flowStepIndex, type FlowStepId } from './nav';

export function FlowStepper({ current }: { current: FlowStepId }) {
  const t = useTranslate();
  const idx = flowStepIndex(current);

  return (
    <ol
      className="flex flex-wrap items-center gap-1 border-b border-kindora-200 bg-white px-6 py-2.5"
      data-testid="flow-stepper"
      aria-label="Connection flow"
    >
      {FLOW_STEPS.map((step, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={step.id} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1 text-kindora-300">/</span>}
            <span
              className={[
                'rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em]',
                active
                  ? 'bg-kindora-950 text-white'
                  : done
                    ? 'text-kindora-500'
                    : 'text-kindora-300',
              ].join(' ')}
              data-active={active ? 'true' : 'false'}
            >
              {t(step.labelKey as Parameters<Translate>[0])}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
