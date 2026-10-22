import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { handle } from '../../http/respond.js';
import { currentUser, requireAdmin } from '../auth/session.js';
import { couponDraws, playerCoupons } from '../game/coupons.js';
import { registerFunds } from '../game/funds.js';
import { hooks } from '../game/hooks.js';
import { addJob } from '../jobs.js';
import type { ModuleRegistrar } from '../index.js';
import { arenaReport } from './admin.js';
import { purgeOldArenaHands, runArenaDeal } from './autodeal.js';
import { board, closeWeeks, setBoardHidden } from './board.js';
import { medals } from './medals.js';
import { enterArena } from './players.js';
import { ensureArena } from './setup.js';
import { cancelOrder, checkout, getOrder, packs, simulatePaid } from './shop.js';
import { starsFunds } from './stars.js';
import { announceBadges, onArenaSettled } from './stats.js';
import { bar, summary } from './summary.js';
import { arenaAccess, listTables, placeArenaCoupon, recentHands, sit } from './table.js';

// ── Registered once at import: Stars funds, settlement hooks, background jobs ──
registerFunds('stars', starsFunds);
if (!hooks.settled.includes(onArenaSettled)) hooks.settled.push(onArenaSettled);
if (!hooks.afterSettled.includes(announceBadges)) hooks.afterSettled.push(announceBadges);
addJob({ name: 'arena-deal', everyMs: 1_000, run: runArenaDeal });
addJob({ name: 'arena-week-close', everyMs: 60_000, run: closeWeeks });
addJob({ name: 'arena-retention', everyMs: 3_600_000, run: purgeOldArenaHands });

const couponBody = z.object({
  tableId: z.string().min(1),
  rounds: z.number().int(),
  selections: z.array(z.object({
    betTypeId: z.string().optional(), market: z.string().optional(), stakeCents: z.number().int(),
  })).max(50),
});

export const registerArena: ModuleRegistrar = (api: Router, ctx: AppContext) => {
  api.get('/arena/summary', handle(async (req) => summary(ctx, currentUser(req).id)));
  api.post('/arena/enter', handle(async (req) => enterArena(ctx, currentUser(req).id)));
  api.get('/arena/bar', handle(async (req) => bar(ctx, currentUser(req).id)));

  api.get('/arena/board', handle(async (req) => {
    const { period } = z.object({ period: z.enum(['week', 'month', 'all']).default('week') }).parse(req.query);
    return board(ctx, currentUser(req).id, period);
  }));
  api.post('/arena/board-visibility', handle(async (req) => {
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    return setBoardHidden(ctx, currentUser(req).id, hidden);
  }));
  api.get('/arena/medals', handle(async (req) => medals(ctx, currentUser(req).id)));

  // ── Stars shop ──
  api.get('/arena/packs', handle(async (req) => packs(ctx, currentUser(req).id)));
  api.post('/arena/checkout', handle(async (req) => {
    const body = z.object({ packId: z.string().min(1).max(40), consent: z.literal(true), locale: z.enum(['en', 'el']).default('en') }).parse(req.body);
    return checkout(ctx, currentUser(req).id, body);
  }));
  api.get('/arena/orders/:id', handle(async (req) => getOrder(ctx, currentUser(req).id, String(req.params.id))));
  api.post('/arena/orders/:id/cancel', handle(async (req) => cancelOrder(ctx, currentUser(req).id, String(req.params.id))));
  api.post('/arena/orders/:id/simulate-paid', handle(async (req) => simulatePaid(ctx, currentUser(req).id, String(req.params.id))));

  // ── Tables and coupons ──
  api.get('/arena/tables', handle(async (req) => { currentUser(req); return listTables(ctx); }));
  api.post('/arena/table/:id/sit', handle(async (req) => sit(ctx, currentUser(req), String(req.params.id))));
  api.get('/arena/table/:id/hands', handle(async (req) => { currentUser(req); return recentHands(ctx, String(req.params.id)); }));
  api.post('/arena/coupon', handle(async (req) => {
    const body = couponBody.parse(req.body);
    return placeArenaCoupon(ctx, currentUser(req), {
      tableId: body.tableId, rounds: body.rounds,
      selections: body.selections.map((s) => ({ market: s.market ?? s.betTypeId ?? '', stakeCents: s.stakeCents })),
    });
  }));
  api.get('/arena/coupons', handle(async (req) => {
    const user = currentUser(req);
    const q = z.object({ status: z.enum(['live', 'completed', 'voided']).optional(), tableId: z.string().optional() }).parse(req.query);
    const { clubId } = await ensureArena(ctx);
    return { coupons: await playerCoupons(ctx, clubId, user.id, { ...q, limit: 30 }) };
  }));
  api.get('/arena/coupon/:id/draws', handle(async (req) => {
    const access = await arenaAccess(ctx, currentUser(req));
    return couponDraws(ctx, access, String(req.params.id));
  }));

  // ── Platform admin report (13 §9) ──
  api.get('/admin/platform/arena', handle(async (req) => {
    requireAdmin(req);
    const { period } = z.object({ period: z.enum(['day', 'week', 'month', 'all']).default('week') }).parse(req.query);
    return arenaReport(ctx, period);
  }));
};
