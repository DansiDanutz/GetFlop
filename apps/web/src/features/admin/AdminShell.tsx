import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { useT } from '../../i18n/i18n';
import { useAdminReconnect } from './api';
import './admin.css';

interface AdminTab { readonly to: string; readonly icon: string; readonly key: string; readonly end?: boolean }

export const ADMIN_TABS: readonly AdminTab[] = [
  { to: '/admin', icon: '◎', key: 'admin_tab_dashboard', end: true },
  { to: '/admin/accounts', icon: '☺', key: 'admin_tab_accounts' },
  { to: '/admin/live', icon: '◉', key: 'admin_tab_live' },
  { to: '/admin/hands', icon: '▦', key: 'admin_tab_hands' },
  { to: '/admin/markets', icon: '%', key: 'admin_tab_markets' },
  { to: '/admin/finance', icon: '⇄', key: 'admin_tab_finance' },
  { to: '/admin/commerce', icon: '◆', key: 'admin_tab_commerce' },
  { to: '/admin/audit', icon: '▤', key: 'admin_tab_audit' },
  { to: '/admin/more', icon: '⋯', key: 'admin_tab_more' },
];

/** Platform admin frame: top bar and its own scrolling tab bar. */
export function AdminShell({ children }: { children: ReactNode }) {
  const t = useT();
  useAdminReconnect();
  return (
    <div className="screen admin">
      <TopBar subtitle={t('admin_title')} />
      <div className="screen-body with-tabs">{children}</div>
      <nav className="tabbar admin-tabs" aria-label={t('admin_title')}>
        {ADMIN_TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico" aria-hidden>{tab.icon}</span>
            <span>{t(tab.key)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
