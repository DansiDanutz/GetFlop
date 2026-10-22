import type { AppRoute } from '../../routes';
import { Account } from './Account';
import { Help } from './Help';
import { History } from './History';
import { InviteLanding } from './Invites';
import { JoinTable } from './JoinTable';
import { MyGames } from './MyGames';

export const meRoutes: AppRoute[] = [
  { path: '/me/games', element: <MyGames />, surface: 'player' },
  { path: '/me/history', element: <History />, surface: 'player' },
  { path: '/account', element: <Account /> },
  { path: '/help', element: <Help />, auth: false },
  { path: '/c/:publicId', element: <InviteLanding />, auth: false },
  { path: '/join/:code', element: <JoinTable />, auth: false },
];
