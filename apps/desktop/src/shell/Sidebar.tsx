import { useTranslate, type Translate } from '../i18n';
import { StatusDot } from '../components/StatusDot';
import { NAV_ITEMS, type NavId } from './nav';

export interface SidebarProps {
  active: NavId | null;
  agentName?: string;
  agentReady: boolean;
  connecting?: boolean;
  onNavigate: (id: NavId) => void;
}

export function Sidebar({
  active,
  agentName,
  agentReady,
  connecting = false,
  onNavigate,
}: SidebarProps) {
  const t = useTranslate();

  return (
    <aside
      className="flex h-full w-[200px] shrink-0 flex-col border-r border-kindora-200 bg-white"
      data-testid="app-sidebar"
    >
      <div className="flex items-baseline gap-2 border-b border-kindora-200 px-4 py-5">
        <p className="font-display text-[22px] font-medium tracking-[-0.03em] text-kindora-950">
          Kindora
        </p>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 p-2" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const navDisabled =
            !agentReady &&
            (item.id === 'connect' ||
              item.id === 'history' ||
              item.id === 'blocked' ||
              item.id === 'settings');
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={navDisabled}
              data-testid={`nav-${item.id}`}
              data-active={isActive ? 'true' : 'false'}
              onClick={() => onNavigate(item.id)}
              className={[
                'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-[13px] transition duration-150',
                isActive
                  ? 'bg-kindora-100 font-medium text-kindora-950'
                  : 'text-kindora-600 hover:bg-kindora-50 hover:text-kindora-900',
                navDisabled ? 'cursor-not-allowed opacity-35' : '',
              ].join(' ')}
            >
              <span
                className="w-4 text-center font-mono text-[11px] text-kindora-400"
                aria-hidden
              >
                {item.icon}
              </span>
              <span className="flex-1 truncate">{t(item.labelKey as Parameters<Translate>[0])}</span>
              {item.id === 'connect' && connecting && <StatusDot tone="busy" label="Connecting" />}
            </button>
          );
        })}
      </nav>

      <div className="border-t border-kindora-200 px-3 py-3">
        <div className="flex items-center gap-2 px-1 py-1">
          <StatusDot tone={agentReady ? 'live' : 'idle'} />
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-kindora-800">
              {agentName ?? t('nav.noAgent')}
            </p>
            <p className="truncate font-mono text-[10px] text-kindora-400">
              {agentReady ? t('nav.agentReady') : t('nav.agentMissing')}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
