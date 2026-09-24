import type { ReactElement } from 'react';

/**
 * Route table. Each feature exports its routes from features/<name>/routes.tsx
 * and is listed here. `auth: false` routes are reachable signed out.
 */
export interface AppRoute {
  readonly path: string;
  readonly element: ReactElement;
  readonly auth?: boolean;
  /** Surface required in the active club (player, dealer, inspector, club). */
  readonly surface?: 'player' | 'dealer' | 'inspector' | 'club';
  readonly admin?: boolean;
}

import { authRoutes } from './features/auth/routes';
import { clubsRoutes } from './features/clubs/routes';
import { playerRoutes } from './features/player/routes';
import { dealerRoutes } from './features/dealer/routes';
import { inspectorRoutes } from './features/inspector/routes';
import { ownerRoutes } from './features/owner/routes';
import { tvRoutes } from './features/tv/routes';
import { tournamentsRoutes } from './features/tournaments/routes';
import { arenaRoutes } from './features/arena/routes';
import { adminRoutes } from './features/admin/routes';

export const ROUTES: AppRoute[] = [
  ...authRoutes,
  ...clubsRoutes,
  ...playerRoutes,
  ...dealerRoutes,
  ...inspectorRoutes,
  ...ownerRoutes,
  ...tvRoutes,
  ...tournamentsRoutes,
  ...arenaRoutes,
  ...adminRoutes,
];
