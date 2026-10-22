import type { ModuleRegistrar } from '../index.js';
import { registerBoardRoutes } from './routes.board.js';
import { registerClubRoutes } from './routes.club.js';
import { registerMemberRoutes } from './routes.members.js';
import { registerNoticeRoutes } from './routes.notices.js';
import { registerScanRoutes } from './routes.scan.js';

/**
 * Members module: members & roles, club settings/profile/rooms/setup/delete, player code and desk scan,
 * club board, medals and notices. Registered before the generic clubs router, so static
 * paths such as /clubs/notices win over /clubs/:clubId/….
 */
export const registerMembers: ModuleRegistrar = (api, ctx) => {
  registerNoticeRoutes(api, ctx);
  registerScanRoutes(api, ctx);
  registerMemberRoutes(api, ctx);
  registerClubRoutes(api, ctx);
  registerBoardRoutes(api, ctx);
};
