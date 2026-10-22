import type { Request, Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import type { ModuleRegistrar } from '../index.js';
import { addJob } from '../jobs.js';
import { listAudiences } from './audiences.js';
import { cancelScheduled, composeMessage, composeSchema } from './compose.js';
import { DELIVERY_JOB_EVERY_MS, SENT_PAGE_DEFAULT, SENT_PAGE_MAX } from './constants.js';
import { deliverDueMessages } from './delivery.js';
import {
  getPrefs, listInbox, markCardShown, messagePhoto, pendingCards, readAll, setPrefs, tapAction,
} from './inbox.js';
import { listPlayers } from './players.js';
import { emailPoster, parsePosterRequest, renderPoster, requireOwner, buildSvg } from './posters/service.js';
import { listSent } from './sent.js';
import { dismissSuggestion, listSuggestions } from './suggestions.js';
import { listTargets } from './targets.js';
import { parseTz } from './time.js';

export { registerTournamentSource, type TournamentSource } from './targets.js';

// Scheduled messages go out from here (registered once, at module load).
addJob({ name: 'messages-scheduled-delivery', everyMs: DELIVERY_JOB_EVERY_MS, run: deliverDueMessages });

const tzOf = (req: Request): string => parseTz(req.query.tz);
const idParam = (req: Request): string => z.string().min(1).max(64).parse(req.params.id);

function registerStaffRoutes(api: Router, ctx: AppContext): void {
  const writer = (req: Request) => requireClub(ctx.db, req, currentUser(req), 'messages');

  api.get('/messages/audiences', handle(async (req) => {
    const access = await writer(req);
    return { audiences: await listAudiences(ctx.db, { clubId: access.club.id, now: ctx.now(), tz: tzOf(req), excludeUserId: access.user.id }) };
  }));

  api.get('/messages/players', handle(async (req) => {
    const access = await writer(req);
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    return { players: await listPlayers(ctx.db, access.club.id, access.user.id, q) };
  }));

  api.get('/messages/targets', handle(async (req) => {
    const access = await writer(req);
    return listTargets(ctx.db, access.club.id, ctx.now());
  }));

  api.get('/messages/suggestions', handle(async (req) => {
    const access = await writer(req);
    return { suggestions: await listSuggestions(ctx, access, tzOf(req)) };
  }));

  api.post('/messages/suggestions/:key/dismiss', handle(async (req) => {
    const access = await writer(req);
    const key = z.string().min(1).max(80).parse(req.params.key);
    return dismissSuggestion(ctx, access, key, parseTz(req.body?.tz ?? req.query.tz));
  }));

  api.get('/messages/sent', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'reports');
    const { limit, before } = z.object({
      limit: z.coerce.number().int().min(1).max(SENT_PAGE_MAX).default(SENT_PAGE_DEFAULT),
      before: z.coerce.date().optional(),
    }).parse(req.query);
    return { ...await listSent(ctx.db, access.club.id, { limit, before }), canWrite: access.rank >= 3 || access.isAdmin };
  }));

  api.post('/messages', handle(async (req) => {
    const access = await writer(req);
    return composeMessage(ctx, access, composeSchema.parse(req.body ?? {}));
  }));

  api.post('/messages/:id/cancel', handle(async (req) => cancelScheduled(ctx, await writer(req), idParam(req))));
}

function registerPlayerRoutes(api: Router, ctx: AppContext): void {
  api.get('/messages', handle(async (req) => listInbox(ctx.db, currentUser(req).id)));
  api.post('/messages/read-all', handle(async (req) => readAll(ctx, currentUser(req).id)));

  api.get('/messages/prefs', handle(async (req) => getPrefs(ctx.db, await requireClub(ctx.db, req, currentUser(req), 'view'))));
  api.put('/messages/prefs', handle(async (req) => {
    const { promoMuted } = z.object({ promoMuted: z.boolean() }).parse(req.body ?? {});
    return setPrefs(ctx, await requireClub(ctx.db, req, currentUser(req), 'view'), promoMuted);
  }));

  api.get('/messages/cards', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return { cards: await pendingCards(ctx.db, access.user.id, access.club.id) };
  }));
  api.post('/messages/:id/card-shown', handle(async (req) => markCardShown(ctx, currentUser(req).id, idParam(req))));
  api.post('/messages/:id/tap', handle(async (req) => tapAction(ctx, currentUser(req).id, idParam(req))));
  api.get('/messages/:id/photo', handle(async (req) => messagePhoto(ctx.db, currentUser(req), idParam(req))));
}

function registerPosterRoutes(api: Router, ctx: AppContext): void {
  api.post('/posters/preview', handle(async (req) => {
    const access = await requireOwner(ctx, req, currentUser(req));
    return { svg: buildSvg(ctx, access, parsePosterRequest(req.body)) };
  }));

  api.post('/posters/render', handle(async (req) => {
    const access = await requireOwner(ctx, req, currentUser(req));
    const file = renderPoster(ctx, access, parsePosterRequest(req.body));
    return { filename: file.filename, mimeType: file.mimeType, base64: file.content.toString('base64') };
  }));

  api.post('/posters/email', handle(async (req) => {
    const access = await requireOwner(ctx, req, currentUser(req));
    return emailPoster(ctx, access, parsePosterRequest(req.body));
  }));
}

/** Club messages (announcements, direct messages, inbox, photo cards) and owner posters. */
export const registerMessages: ModuleRegistrar = (api, ctx) => {
  registerStaffRoutes(api, ctx);
  registerPlayerRoutes(api, ctx);
  registerPosterRoutes(api, ctx);
};
