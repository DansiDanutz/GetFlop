import type { AppRoute } from '../../routes';
import { Floor } from './Floor';
import { Reports } from './Reports';
import { Requests } from './Requests';
import { Simulation } from './Simulation';
import { TableDetail } from './TableDetail';
import { TablesPage } from './TablesPage';

/** Staff surface: floor, tables, requests, reports (inspector, manager, owner). */
export const inspectorRoutes: AppRoute[] = [
  { path: '/inspector', element: <Floor />, surface: 'inspector' },
  { path: '/inspector/simulation', element: <Simulation />, surface: 'inspector' },
  { path: '/club/tables', element: <TablesPage />, surface: 'inspector' },
  { path: '/club/tables/:id', element: <TableDetail />, surface: 'inspector' },
  { path: '/club/requests', element: <Requests />, surface: 'inspector' },
  { path: '/club/reports', element: <Reports />, surface: 'inspector' },
  { path: '/club/reports/:segment', element: <Reports />, surface: 'inspector' },
];
