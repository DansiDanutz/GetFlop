import type { ReactNode } from 'react';
import { TopBar } from '../../components/TopBar';
import { TabBar, type Tab } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';

/**
 * Staff surface frame: top bar + the five staff tabs
 * (Tables · Members · Requests · Reports · Club). The floor (inspector) sees the
 * tabs its capabilities allow. Pages render inside `children`.
 */
export function StaffShell({ children, status, dots = {} }: { children: ReactNode; status?: ReactNode; dots?: Partial<Record<string, boolean>> }) {
  const t = useT();
  const { can } = useSession();
  const tabs: Tab[] = [
    { to: '/inspector', icon: '◉', label: t('staff_tab_floor'), dot: dots.floor },
    { to: '/club/tables', icon: '▦', label: t('staff_tab_tables') },
    { to: '/club/members', icon: '☺', label: t('staff_tab_members'), dot: dots.members },
    { to: '/club/requests', icon: '⇄', label: t('staff_tab_requests'), dot: dots.requests },
    { to: '/club/reports', icon: '▤', label: t('staff_tab_reports') },
  ];
  if (can('settings')) tabs.push({ to: '/club/settings', icon: '⚙', label: t('staff_tab_club'), dot: dots.club });
  return (
    <div className="screen">
      <TopBar status={status} />
      <div className="screen-body with-tabs">{children}</div>
      <TabBar tabs={tabs} />
    </div>
  );
}
