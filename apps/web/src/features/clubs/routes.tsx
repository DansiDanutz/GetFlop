import type { AppRoute } from '../../routes';
import { Clubs } from './Clubs';

export const clubsRoutes: AppRoute[] = [
  { path: '/clubs', element: <Clubs /> },
];
