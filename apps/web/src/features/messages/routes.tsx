import type { AppRoute } from '../../routes';
import { ClubMessages } from './ClubMessages';
import { Inbox } from './Inbox';
import { Posters } from './Posters';

export const messagesRoutes: AppRoute[] = [
  // Staff: owner and managers write; inspectors see the read-only log.
  { path: '/club/messages', element: <ClubMessages />, surface: 'inspector' },
  { path: '/club/posters', element: <Posters />, surface: 'club' },
  { path: '/me/inbox', element: <Inbox /> },
];
