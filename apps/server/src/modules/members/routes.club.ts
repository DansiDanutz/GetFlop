import type { Request, Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { can, loadClubAccess, type ClubAccess } from '../clubs/access.js';
import { deleteCheck, deleteClub } from './deleteClub.js';
import { assertLogo } from './photo.js';
import { createRoom, deleteRoom, listRooms, renameRoom } from './rooms.js';
import {
  assertSettingsAccess, inviteUrl, liveBigCents, markInviteShared, settingsView, updateProfile, updateSettings,
} from './settings.js';
import { clubSetup } from './setup.js';
import { supplyDetail } from './supply.js';

const nameBody = z.object({ name: z.string().max(200) });

/** Club settings, profile, rooms, setup checklist, invite and delete (03 §3, §7, §9, §10, §12; 08 §4). */
export function registerClubRoutes(api: Router, ctx: AppContext): void {
  const access = (req: Request): Promise<ClubAccess> => loadClubAccess(ctx.db, currentUser(req), String(req.params.clubId));
  const member = async (req: Request): Promise<ClubAccess> => {
    const a = await access(req);
    if (!a.membership && !a.isAdmin) throw new AppError('club.access_denied', 403);
    return a;
  };
  const staff = async (req: Request): Promise<ClubAccess> => {
    const a = await member(req);
    if (!can(a, 'members.review')) throw new AppError('club.capability_missing', 403);
    return a;
  };

  api.get('/clubs/:clubId/settings', handle(async (req) => {
    const a = await member(req);
    assertSettingsAccess(a);
    return settingsView(ctx, a.club);
  }));

  api.put('/clubs/:clubId/profile', handle(async (req) => {
    const body = z.object({
      name: z.string().max(200).optional(), description: z.string().max(5_000).nullable().optional(),
      logo: z.string().max(1_000_000).nullable().optional(),
    }).parse(req.body);
    return updateProfile(ctx, await member(req), body, assertLogo);
  }));

  api.put('/clubs/:clubId/settings', handle(async (req) => {
    const body = z.object({
      dealerSitApproval: z.boolean().optional(), liveBigPoints: z.union([z.string(), z.number()]).optional(), boardEnabled: z.boolean().optional(),
    }).parse(req.body);
    return updateSettings(ctx, await member(req), body);
  }));

  api.get('/clubs/:clubId/dealer-sit-approval', handle(async (req) => {
    const a = await member(req);
    assertSettingsAccess(a);
    return { on: a.club.dealerSitApproval };
  }));

  api.put('/clubs/:clubId/dealer-sit-approval', handle(async (req) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const view = await updateSettings(ctx, await member(req), { dealerSitApproval: on });
    return { on: view.dealerSitApproval };
  }));

  const liveBig = (cents: number) => ({ bigPoints: cents / 100, bigCents: cents });

  api.get('/clubs/:clubId/live-big', handle(async (req) => {
    const a = await staff(req);
    return liveBig(liveBigCents(a.club));
  }));

  api.put('/clubs/:clubId/live-big', handle(async (req) => {
    const { bigPoints } = z.object({ bigPoints: z.unknown() }).parse(req.body);
    const view = await updateSettings(ctx, await member(req), { liveBigPoints: bigPoints ?? '' });
    return liveBig(view.liveBigCents);
  }));

  api.get('/clubs/:clubId/rooms', handle(async (req) => ({ rooms: await listRooms(ctx.db, (await staff(req)).club.id) })));
  api.post('/clubs/:clubId/rooms', handle(async (req) => createRoom(ctx, await member(req), nameBody.parse(req.body))));
  api.put('/clubs/:clubId/rooms/:roomId', handle(async (req) =>
    renameRoom(ctx, await member(req), String(req.params.roomId), nameBody.parse(req.body))));
  api.delete('/clubs/:clubId/rooms/:roomId', handle(async (req) => deleteRoom(ctx, await member(req), String(req.params.roomId))));

  api.get('/clubs/:clubId/setup', handle(async (req) => ({ setup: await clubSetup(ctx.db, (await staff(req)).club) })));

  api.get('/clubs/:clubId/invite', handle(async (req) => {
    const { club } = await member(req);
    return { clubId: club.id, publicId: club.publicId, name: club.name, url: inviteUrl(ctx, club.publicId) };
  }));

  api.post('/clubs/:clubId/invite/shared', handle(async (req) => {
    await markInviteShared(ctx, await staff(req));
    return { shared: true };
  }));

  api.get('/clubs/:clubId/points/detail', handle(async (req) => supplyDetail(ctx, await member(req))));

  api.get('/clubs/:clubId/delete-check', handle(async (req) => deleteCheck(ctx, await member(req))));

  api.post('/clubs/:clubId/delete', handle(async (req) => {
    const body = z.object({ confirmName: z.string().max(200).optional(), reason: z.string().max(500).optional() }).parse(req.body);
    return deleteClub(ctx, await member(req), body);
  }));
}
