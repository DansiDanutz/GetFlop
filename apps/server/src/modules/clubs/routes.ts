import { and, eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { memberships, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { CAPABILITY_RANK, can, loadClubAccess, requireClub, type Capability } from './access.js';
import {
  activeMemberCount, createClub, findByPublicId, myClubs, pendingJoinRequests, publicClubCard, requestJoin, reviewJoin, surfacesFor,
} from './service.js';

const joinSourceSchema = z.enum(['club_id', 'invite', 'qr', 'scan']).default('club_id');

export function clubsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get('/mine', handle(async (req) => {
    const user = currentUser(req);
    return { clubs: await myClubs(ctx.db, user.id), activeClubId: user.activeClubId };
  }));

  r.post('/', handle(async (req) => {
    const body = z.object({ name: z.string(), description: z.string().optional(), acceptClubTerms: z.boolean().optional() }).parse(req.body);
    const club = await createClub(ctx, currentUser(req), body);
    return { club };
  }));

  r.post('/select', handle(async (req) => {
    const user = currentUser(req);
    const { clubId } = z.object({ clubId: z.string() }).parse(req.body);
    const access = await loadClubAccess(ctx.db, user, clubId);
    if (!access.membership && !access.isAdmin) throw new AppError('club.access_denied', 403);
    await ctx.db.update(users).set({ activeClubId: clubId }).where(eq(users.id, user.id));
    return { activeClubId: clubId };
  }));

  r.get('/context', handle(async (req) => {
    const user = currentUser(req);
    if (!user.activeClubId) throw new AppError('club.context_required', 400);
    const access = await loadClubAccess(ctx.db, user, user.activeClubId);
    if (!access.membership && !access.isAdmin) throw new AppError('club.access_denied', 403);
    const capabilities = (['play', ...Object.keys(CAPABILITY_RANK)] as Capability[]).filter((c) => can(access, c));
    return {
      club: {
        id: access.club.id, name: access.club.name, publicId: access.club.publicId, photoUrl: access.club.photoUrl,
        level: access.club.level, inviteToken: access.club.inviteToken,
      },
      roles: access.roles,
      playMode: access.membership?.playMode ?? 'watch',
      surfaces: surfacesFor(access.roles, access.isAdmin),
      capabilities,
    };
  }));

  r.get('/find/:publicId', handle(async (req) => {
    const user = currentUser(req);
    const club = await findByPublicId(ctx.db, String(req.params.publicId));
    const [mine] = await ctx.db.select({ status: memberships.status }).from(memberships)
      .where(and(eq(memberships.clubId, club.id), eq(memberships.userId, user.id))).limit(1);
    return { club: publicClubCard(club, await activeMemberCount(ctx.db, club.id)), membershipStatus: mine?.status ?? null };
  }));

  r.post('/:clubId/join', handle(async (req) => {
    const user = currentUser(req);
    const { source } = z.object({ source: joinSourceSchema }).parse(req.body ?? {});
    const access = await loadClubAccess(ctx.db, user, String(req.params.clubId));
    const membership = await requestJoin(ctx, user.id, access.club.id, source);
    return { status: membership.status };
  }));

  r.get('/:clubId/join-requests', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'members.review', String(req.params.clubId));
    return { requests: await pendingJoinRequests(ctx.db, access.club.id) };
  }));

  r.post('/:clubId/join-requests/:membershipId/:decision', handle(async (req) => {
    const decision = z.enum(['approve', 'reject']).parse(req.params.decision);
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    const access = await loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId));
    const membership = await reviewJoin(ctx, access, String(req.params.membershipId), decision, reason);
    return { status: membership.status };
  }));

  return r;
}
