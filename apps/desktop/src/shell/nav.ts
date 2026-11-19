/**
 * Sidebar destinations. Connection-flow screens (identify → chat) all
 * highlight the Connect item rather than inventing extra nav entries.
 */
export type NavId = 'home' | 'connect' | 'history' | 'blocked' | 'settings' | 'demo';

export const NAV_ITEMS: readonly {
  id: NavId;
  labelKey: string;
  icon: string;
}[] = [
  { id: 'home', labelKey: 'nav.agent', icon: '◇' },
  { id: 'connect', labelKey: 'nav.connect', icon: '⟷' },
  { id: 'history', labelKey: 'nav.history', icon: '☰' },
  { id: 'blocked', labelKey: 'nav.blocked', icon: '⊘' },
  { id: 'settings', labelKey: 'nav.settings', icon: '⚙' },
  { id: 'demo', labelKey: 'nav.demo', icon: '▷' },
] as const;

/** Map an App view kind onto a sidebar highlight. */
export function navIdForViewKind(kind: string): NavId | null {
  switch (kind) {
    case 'home':
    case 'edit':
      return 'home';
    case 'connect':
    case 'identify':
    case 'verify-peer':
    case 'consent':
    case 'match':
    case 'icebreaker':
    case 'chat':
      return 'connect';
    case 'history':
      return 'history';
    case 'blocked':
      return 'blocked';
    case 'settings':
      return 'settings';
    case 'demo':
      return 'demo';
    default:
      return null;
  }
}

export type FlowStepId = 'connect' | 'identify' | 'consent' | 'match' | 'icebreaker' | 'chat';

export const FLOW_STEPS: readonly { id: FlowStepId; labelKey: string }[] = [
  { id: 'connect', labelKey: 'flow.connect' },
  { id: 'identify', labelKey: 'flow.identify' },
  { id: 'consent', labelKey: 'flow.consent' },
  { id: 'match', labelKey: 'flow.match' },
  { id: 'icebreaker', labelKey: 'flow.icebreaker' },
  { id: 'chat', labelKey: 'flow.chat' },
] as const;

export function flowStepIndex(id: FlowStepId): number {
  return FLOW_STEPS.findIndex((s) => s.id === id);
}
