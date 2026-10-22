import { z } from 'zod';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import type { ModuleRegistrar } from '../index.js';
import { history, myGames, tableByCode } from './service.js';

export const DEFAULT_HISTORY_LIMIT = 30;
export const MAX_HISTORY_LIMIT = 100;
const DAY_MS = 86_400_000;

const historyQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT).default(DEFAULT_HISTORY_LIMIT),
  /** Start of the player's local day (ISO); defaults to the last 24 hours. */
  since: z.iso.datetime({ offset: true }).optional(),
});

/** The player's own things: my games, history, table QR lookup. */
export const registerMe: ModuleRegistrar = (api, ctx) => {
  api.get('/player/my-games', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return myGames(ctx, access);
  }));

  api.get('/player/history', handle(async (req) => {
    const q = historyQuery.parse(req.query);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const since = q.since ? new Date(q.since) : new Date(ctx.now().getTime() - DAY_MS);
    return history(ctx, access, q.limit, since);
  }));

  api.get('/tables/by-code/:code', handle(async (req) => tableByCode(ctx, String(req.params.code), req.user?.id ?? null)));
};
