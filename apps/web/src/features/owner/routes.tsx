import type { AppRoute } from '../../routes';
import { ClubSettingsPage } from './ClubSettingsPage';
import { InvitePage } from './InvitePage';
import { MemberCardPage } from './MemberCardPage';
import { Members } from './Members';
import { MyCodePage } from './MyCodePage';
import { PointsSupplyPage } from './PointsSupplyPage';
import { ScanDeskPage } from './ScanDeskPage';
import { SetupPage } from './SetupPage';

/**
 * Owner / manager surface: Members tab and member card (inspector and up), Club tab
 * (settings, setup, invite, Points supply; manager and up), player "My code" and the desk scan.
 * The `/:clubId` variants are the platform admin's view of any club.
 */
export const ownerRoutes: AppRoute[] = [
  { path: '/club/members', element: <Members />, surface: 'inspector' },
  { path: '/club/members/:clubId', element: <Members /> },
  { path: '/club/card/:userId', element: <MemberCardPage />, surface: 'inspector' },
  { path: '/club/card/:clubId/:userId', element: <MemberCardPage /> },
  { path: '/club/settings', element: <ClubSettingsPage />, surface: 'club' },
  { path: '/club/setup', element: <SetupPage />, surface: 'inspector' },
  { path: '/club/invite', element: <InvitePage />, surface: 'inspector' },
  { path: '/club/points', element: <PointsSupplyPage />, surface: 'club' },
  { path: '/club/scan', element: <ScanDeskPage /> },
  { path: '/pc/:code', element: <ScanDeskPage /> },
  { path: '/me/code', element: <MyCodePage /> },
];
