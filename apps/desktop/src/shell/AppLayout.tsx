import type { ReactNode } from 'react';
import { Sidebar, type SidebarProps } from './Sidebar';
import { FlowStepper } from './FlowStepper';
import type { FlowStepId } from './nav';

export interface AppLayoutProps {
  sidebar: SidebarProps;
  topBar?: ReactNode;
  flowStep?: FlowStepId;
  banner?: ReactNode;
  children: ReactNode;
  flush?: boolean;
}

export function AppLayout({
  sidebar,
  topBar,
  flowStep,
  banner,
  children,
  flush = false,
}: AppLayoutProps) {
  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-kindora-50"
      data-testid="app-layout"
    >
      <Sidebar {...sidebar} />
      <div className="flex min-w-0 flex-1 flex-col bg-kindora-50">
        {topBar}
        {flowStep && <FlowStepper current={flowStep} />}
        {banner && <div className="border-b border-kindora-200 px-6 py-2.5">{banner}</div>}
        <div
          className={
            flush ? 'kindora-page-wide min-h-0 flex-1' : 'min-h-0 flex-1 overflow-y-auto'
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
