import type { AppRoute } from '../../routes';
import { DealerConsole } from './DealerConsole';
import { DealerShell } from './DealerShell';
import { DealerTables } from './DealerTables';

export const dealerRoutes: AppRoute[] = [
  { path: '/dealer', element: <DealerShell><DealerTables /></DealerShell>, surface: 'dealer' },
  { path: '/dealer/table/:tableId', element: <DealerShell><DealerConsole /></DealerShell>, surface: 'dealer' },
];
