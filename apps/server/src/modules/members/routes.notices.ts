import type { Router } from 'express';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { markNoticeRead, unreadNotices } from './notices.js';

export function registerNoticeRoutes(api: Router, ctx: AppContext): void {
  api.get('/clubs/notices', handle(async (req) => ({ notices: await unreadNotices(ctx.db, currentUser(req).id) })));

  api.post('/clubs/notices/:id/read', handle(async (req) =>
    ({ read: await markNoticeRead(ctx, currentUser(req).id, String(req.params.id)) })));
}
