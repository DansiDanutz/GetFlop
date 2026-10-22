import type { AppRoute } from '../../routes';
import { Lobby } from './Lobby';
import { Rules } from './Rules';
import { TableScreen } from './TableScreen';

export const playerRoutes: AppRoute[] = [
  { path: '/player', element: <Lobby />, surface: 'player' },
  { path: '/player/rules', element: <Rules />, surface: 'player' },
  { path: '/player/table/:id', element: <TableScreen />, surface: 'player' },
  { path: '/player/table/:id/heat', element: <TableScreen showHeat />, surface: 'player' },
];
