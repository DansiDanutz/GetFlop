import type { AppRoute } from '../../routes';
import { DisplayScreen } from './DisplayScreen';
import { PairingScreen } from './PairingScreen';
import { TvHome } from './TvHome';

/** Public TV routes: no user session, the display token is the only credential. */
export const tvRoutes: AppRoute[] = [
  { path: '/tv', element: <TvHome />, auth: false },
  { path: '/tv/cash', element: <PairingScreen kind="cash" />, auth: false },
  { path: '/tv/cash/:token', element: <DisplayScreen kind="cash" />, auth: false },
  { path: '/tv/tournament', element: <PairingScreen kind="tournament" />, auth: false },
  { path: '/tv/tournament/:token', element: <DisplayScreen kind="tournament" />, auth: false },
];
