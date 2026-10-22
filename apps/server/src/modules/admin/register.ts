import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { handle } from '../../http/respond.js';
import { addSocketExtension } from '../jobs.js';
import type { ModuleRegistrar } from '../index.js';
import { requireAdmin } from '../auth/session.js';
import { tzSchema } from '../inspector/time.js';
import { accountDetail, accountSummary } from './accountDetail.js';
import { adminUserView, createUser, findUser, listAccounts, listUsers, resetPin, setActive, updateUser } from './accounts.js';
import { listAudit } from './audit.js';
import { listBetTypes, updateBetType } from './betTypes.js';
import { dailyPlayerNet, reconciliation } from './financials.js';
import { moreSection, moreSections } from './more.js';
import { parsePeriod, periodQuery } from './period.js';
import { dashboard, platformOverview } from './platform.js';
import { allTables, handBets, listHands, liveOverview } from './play.js';
import { presenceExtension } from './presence.js';
import { voidBet } from './void.js';

// Top level: runs once. Tracks who is online for the platform overview.
addSocketExtension(presenceExtension);

const ACCOUNTS_PAGE = 50;
const AUDIT_PAGE = 50;
const MAX_PAGE = 200;

const id = z.string().min(1).max(64);
const pageSize = (fallback: number) => z.coerce.number().int().min(1).max(MAX_PAGE).default(fallback);

const accountsQuery = z.object({
  filter: z.enum(['all', 'players', 'admins', 'inactive', 'bots']).default('all'),
  q: z.string().max(100).optional(),
  limit: pageSize(ACCOUNTS_PAGE),
  offset: z.coerce.number().int().min(0).default(0),
});

const createBody = z.object({
  username: z.string().max(40).optional(),
  displayName: z.string().max(200).optional(),
  role: z.string().max(20).optional(),
  pin: z.string().max(20).optional(),
});
const updateBody = z.object({ username: z.string().max(40).optional(), displayName: z.string().max(200).optional() });
const toggleBody = z.object({ active: z.boolean() });
const resetPinBody = z.object({ newPin: z.string().max(20) });

const handsQuery = periodQuery.extend({ tableId: id.optional(), handNumber: z.coerce.number().int().min(1).optional() });
const voidBody = z.object({ reason: z.string().max(500).optional() });

const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: pageSize(AUDIT_PAGE),
  action: z.string().max(60).optional(),
  actorId: id.optional(),
  clubId: id.optional(),
  targetId: id.optional(),
});

const betTypeBody = z.object({
  payout_odds: z.number().finite().optional(),
  multiplier: z.number().finite().optional(),
  probability: z.number().finite().optional(),
  fair_odds: z.number().finite().optional(),
  is_active: z.boolean().optional(),
});

const tzQuery = z.object({ tz: tzSchema });

/** Every /admin route is for platform admins only (auth.required / auth.forbidden). */
function adminOnly(req: Request, _res: Response, next: NextFunction): void {
  try {
    requireAdmin(req);
    next();
  } catch (err) {
    next(err);
  }
}

const param = (req: Request, name: string): string => id.parse(req.params[name]);

/**
 * Platform admin module (spec 13). Commerce (/admin/commerce/*) and the Arena report
 * (/admin/platform/arena) are served by their own modules, mounted before this one.
 */
export const registerAdmin: ModuleRegistrar = (api, ctx) => {
  const r = Router();
  r.use(adminOnly);

  r.get('/', handle((req) => dashboard(ctx, tzQuery.parse(req.query).tz)));
  r.get('/platform', handle((req) => {
    const q = periodQuery.parse(req.query);
    return platformOverview(ctx, parsePeriod(q), q.tz);
  }));

  r.get('/accounts', handle((req) => listAccounts(ctx, accountsQuery.parse(req.query))));
  r.get('/account/:id', handle((req) => accountSummary(ctx, param(req, 'id'))));
  r.get('/players/:id/detail', handle((req) => accountDetail(ctx, param(req, 'id'))));
  r.get('/users', handle(() => listUsers(ctx)));
  r.post('/users', handle((req) => createUser(ctx, requireAdmin(req), createBody.parse(req.body))));
  r.get('/users/:id', handle(async (req) => ({ user: adminUserView(await findUser(ctx.db, param(req, 'id'))) })));
  r.put('/users/:id', handle((req) => updateUser(ctx, requireAdmin(req), param(req, 'id'), updateBody.parse(req.body))));
  r.put('/users/:id/toggle-active', handle((req) =>
    setActive(ctx, requireAdmin(req), param(req, 'id'), toggleBody.parse(req.body).active)));
  r.put('/users/:id/reset-pin', handle((req) =>
    resetPin(ctx, requireAdmin(req), param(req, 'id'), resetPinBody.parse(req.body).newPin)));

  r.get('/live', handle(() => liveOverview(ctx)));
  r.get('/tables', handle(() => allTables(ctx)));
  r.get('/hands', handle((req) => {
    const q = handsQuery.parse(req.query);
    return listHands(ctx, { tableId: q.tableId, handNumber: q.handNumber, range: parsePeriod(q) });
  }));
  r.get('/hands/:id/bets', handle((req) => handBets(ctx, param(req, 'id'))));
  r.post('/bets/:id/void', handle((req) => voidBet(ctx, requireAdmin(req), param(req, 'id'), voidBody.parse(req.body).reason)));

  r.get('/financials/reconciliation', handle((req) => {
    const q = periodQuery.parse(req.query);
    return reconciliation(ctx, q.tz, parsePeriod(q));
  }));
  r.get('/financials/daily-player-net', handle((req) => dailyPlayerNet(ctx, tzQuery.parse(req.query).tz)));

  r.get('/audit', handle((req) => listAudit(ctx, auditQuery.parse(req.query))));

  r.get('/bet-types', handle(() => listBetTypes(ctx)));
  r.put('/bet-types/:slug', handle((req) => {
    const b = betTypeBody.parse(req.body);
    return updateBetType(ctx, requireAdmin(req), param(req, 'slug'), {
      payoutOdds: b.payout_odds, multiplier: b.multiplier, probability: b.probability, fairOdds: b.fair_odds, isActive: b.is_active,
    });
  }));

  r.get('/more', handle(() => moreSections()));
  r.get('/more/:key', handle((req) => moreSection(ctx, param(req, 'key'))));

  api.use('/admin', r);
};
