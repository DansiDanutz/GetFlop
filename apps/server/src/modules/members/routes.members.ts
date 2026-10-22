import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { loadClubAccess } from '../clubs/access.js';
import { memberCard, memberCoupon, memberCoupons } from './card.js';
import { leaveClub, removeMember } from './lifecycle.js';
import { listMembers, MEMBER_FILTERS } from './list.js';
import { parseRange } from './range.js';
import { changeRole, setPlayMode, transferOwnership } from './roles.js';

const reasonBody = z.object({ reason: z.string().max(500).optional() });

/** Members & roles: list, member card, roles, play mode, remove, leave, ownership (03 §8, 08 §2). */
export function registerMemberRoutes(api: Router, ctx: AppContext): void {
  const access = (req: Parameters<Parameters<typeof handle>[0]>[0]) =>
    loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId));
  const target = (req: { params: Record<string, unknown> }) => String(req.params.userId);

  api.get('/clubs/:clubId/members', handle(async (req) => {
    const q = z.object({ filter: z.enum(MEMBER_FILTERS).default('all'), q: z.string().max(60).default('') }).parse(req.query);
    return listMembers(ctx.db, await access(req), q.filter, q.q);
  }));

  api.get('/clubs/:clubId/members/:userId', handle(async (req) =>
    memberCard(ctx, await access(req), target(req), parseRange(req.query))));

  api.get('/clubs/:clubId/members/:userId/coupons', handle(async (req) => {
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).max(100_000).default(0) }).parse(req.query);
    return memberCoupons(ctx, await access(req), target(req), parseRange(req.query), offset);
  }));

  api.get('/clubs/:clubId/members/:userId/coupons/:couponId', handle(async (req) =>
    memberCoupon(ctx, await access(req), target(req), String(req.params.couponId))));

  api.post('/clubs/:clubId/members/:userId/roles/:role', handle(async (req) =>
    changeRole(ctx, await access(req), target(req), String(req.params.role), 'grant')));

  api.delete('/clubs/:clubId/members/:userId/roles/:role', handle(async (req) =>
    changeRole(ctx, await access(req), target(req), String(req.params.role), 'revoke')));

  api.put('/clubs/:clubId/members/:userId/play-mode', handle(async (req) => {
    const { mode } = z.object({ mode: z.string() }).parse(req.body);
    return setPlayMode(ctx, await access(req), target(req), mode);
  }));

  api.post('/clubs/:clubId/members/:userId/remove', handle(async (req) =>
    removeMember(ctx, await access(req), target(req), reasonBody.parse(req.body ?? {}).reason)));

  api.post('/clubs/:clubId/leave', handle(async (req) =>
    leaveClub(ctx, await access(req), reasonBody.parse(req.body ?? {}).reason)));

  api.post('/clubs/:clubId/owner/transfer', handle(async (req) => {
    const { userId } = z.object({ userId: z.string().min(1) }).parse(req.body);
    return transferOwnership(ctx, await access(req), userId);
  }));
}
