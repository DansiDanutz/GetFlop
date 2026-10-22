import { z } from 'zod';
import { handle } from '../../http/respond.js';
import { currentUser } from '../auth/session.js';
import { requireClub } from '../clubs/access.js';
import { getTable } from '../game/tables.js';
import type { ModuleRegistrar } from '../index.js';
import { HEAT_WINDOW, tableHeat } from './heat.js';
import { handStats, latestSettled } from './service.js';

/** Most tables a catch-up request may ask for (the client has at most 4 games open). */
const MAX_CATCH_UP_TABLES = 20;
const MIN_HEAT_WINDOW = 10;
const MAX_HEAT_WINDOW = 200;

const heatQuery = z.object({
  window: z.coerce.number().int().min(MIN_HEAT_WINDOW).max(MAX_HEAT_WINDOW).optional(),
});

const latestQuery = z.object({
  ids: z.string().min(1).transform((s) => [...new Set(s.split(',').map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.string()).min(1).max(MAX_CATCH_UP_TABLES)),
});

/**
 * Player module: table-side statistics that the game module does not own.
 * The table, coupons and draws endpoints live in modules/game/routes.ts.
 */
export const registerPlayer: ModuleRegistrar = (api, ctx) => {
  api.get('/player/table/:id/heat', handle(async (req) => {
    const { window } = heatQuery.parse(req.query);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const table = await getTable(ctx.db, access.club.id, String(req.params.id));
    return tableHeat(ctx.db, table, window ?? HEAT_WINDOW);
  }));

  api.get('/player/table/:id/stats', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const table = await getTable(ctx.db, access.club.id, String(req.params.id));
    return handStats(ctx, table);
  }));

  api.get('/player/tables/latest-settled', handle(async (req) => {
    const user = currentUser(req);
    const { ids } = latestQuery.parse(req.query);
    return { tables: await latestSettled(ctx, user, ids) };
  }));
};
