import type { AppRoute } from '../../routes';
import { AccountDetailScreen } from './AccountDetail';
import { AccountsScreen } from './Accounts';
import { AuditScreen } from './Audit';
import { CommerceScreen } from './Commerce';
import { DashboardScreen } from './Dashboard';
import { FinanceScreen } from './Finance';
import { HandsScreen } from './Hands';
import { LiveScreen } from './Live';
import { MarketsScreen } from './Markets';
import { MoreScreen, MoreSectionScreen } from './More';

/** Platform admin (#/admin…). Every route requires an admin account. */
export const adminRoutes: AppRoute[] = [
  { path: '/admin', element: <DashboardScreen />, admin: true },
  { path: '/admin/accounts', element: <AccountsScreen />, admin: true },
  { path: '/admin/account/:id', element: <AccountDetailScreen />, admin: true },
  { path: '/admin/live', element: <LiveScreen />, admin: true },
  { path: '/admin/hands', element: <HandsScreen />, admin: true },
  { path: '/admin/markets', element: <MarketsScreen />, admin: true },
  { path: '/admin/finance', element: <FinanceScreen />, admin: true },
  { path: '/admin/commerce', element: <CommerceScreen />, admin: true },
  { path: '/platform/commerce', element: <CommerceScreen />, admin: true },
  { path: '/admin/audit', element: <AuditScreen />, admin: true },
  { path: '/admin/more', element: <MoreScreen />, admin: true },
  { path: '/admin/more/:key', element: <MoreSectionScreen />, admin: true },
];
