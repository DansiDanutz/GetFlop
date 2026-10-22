import type { TableLimitsJson } from '../../db/schema/index.js';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { clubTables, hands, memberships, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { handle } from '../../http/respond.js';
import { rooms } from '../../realtime/events.js';
import { currentUser } from '../auth/session.js';
import { can, requireClub } from '../clubs/access.js';
import { couponDraws, placeCoupon, playerCoupons } from './coupons.js';
import { seatDealer, standUp } from './dealer.js';
import { fundsFor } from './funds.js';
import { publicHand } from './hands.js';
import { catalogue, marketList, offeredAt } from './markets.js';
import {
  closeTable, clubTablesList, createTable, emitTableChanged, getTable, liveHand, openTable,
  setTableLimits, setTableMarkets, updateTable, type TableRow,
} from './tables.js';
import { unitForTable } from './coupons.js';
import { applyCreateExtras, prepareOpen } from '../inspector/openFlow.js';
import { detailedClosePreview } from '../inspector/tablesAdmin.js';

const tableInput = z.object({
  name: z.string().optional(),
  game: z.enum(['nlh', 'plo', 'other']).optional(),
  photoUrl: z.string().max(500_000).nullable().optional(),
  featured: z.boolean().optional(),
  roomId: z.string().nullable().optional(),
});

const limitsInput = z.object({
  minCents: z.number().int(),
  maxCents: z.number().int(),
  couponCapCents: z.number().int(),
  maxRounds: z.number().int().optional(),
  marketMaxCents: z.record(z.string(), z.number().int()).optional(),
});

export async function tableView(ctx: AppContext, table: TableRow) {
  const cat = await catalogue(ctx.db);
  const hand = await liveHand(ctx.db, table.id);
  const [last] = await ctx.db.select().from(hands)
    .where(and(eq(hands.tableId, table.id), eq(hands.status, 'settled'))).orderBy(desc(hands.handNumber)).limit(1);
  let dealerName: string | null = null;
  if (table.dealerId) {
    const [d] = await ctx.db.select({ n: users.displayName, u: users.username }).from(users).where(eq(users.id, table.dealerId));
    dealerName = d?.n ?? d?.u ?? null;
  }
  return {
    id: table.id, clubId: table.clubId, name: table.name, game: table.game, photoUrl: table.photoUrl, featured: table.featured,
    kind: table.kind, status: table.status, isAutoDeal: table.isAutoDeal, dealerId: table.dealerId, dealerName,
    joinCode: table.joinCode, unit: unitForTable(table.kind), limits: table.limits, markets: table.markets,
    tournamentId: table.tournamentId, lastHandNumber: table.lastHandNumber, lastHandAt: table.lastHandAt,
    offered: marketList(cat, offeredAt(table.markets, cat)),
    currentHand: hand ? publicHand(hand) : null,
    lastHand: last ? publicHand(last) : null,
  };
}

export function registerGame(api: Router, ctx: AppContext): void {
  // ── Markets catalogue ──
  api.get('/tournaments/bet-types/list', handle(async () => {
    const cat = await catalogue(ctx.db);
    return { betTypes: marketList(cat, new Set([...cat.values()].filter((b) => b.active).map((b) => b.slug))) };
  }));

  // ── Floor: tables ──
  api.get('/inspector/tables', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const list = await clubTablesList(ctx.db, access.club.id, { includeClosed: true });
    return { tables: await Promise.all(list.map((t) => tableView(ctx, t))) };
  }));

  api.post('/inspector/table', handle(async (req) => {
    const body = tableInput.extend({ name: z.string() }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const created = await createTable(ctx, access, body);
    return { table: await tableView(ctx, await applyCreateExtras(ctx, access, created, req.body)) };
  }));

  api.put('/inspector/table/:id', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return { table: await tableView(ctx, await updateTable(ctx, access, String(req.params.id), tableInput.parse(req.body))) };
  }));

  api.put('/inspector/table/:id/open', handle(async (req) => {
    const { dealerId, leaveHeld } = z.object({ dealerId: z.string().nullable().optional(), leaveHeld: z.boolean().optional() }).parse(req.body ?? {});
    let access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const prep = await prepareOpen(ctx, access, String(req.params.id), dealerId, leaveHeld ?? false);
    if (prep.grantedSelfDealer) access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    let table = await openTable(ctx, access, String(req.params.id));
    if (dealerId) table = await seatDealer(ctx, access.club.id, table.id, dealerId, { staff: access });
    emitTableChanged(ctx, table);
    return { table: await tableView(ctx, table), left: prep.left };
  }));

  api.get('/inspector/table/:id/close-preview', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return detailedClosePreview(ctx, access, String(req.params.id));
  }));

  api.put('/inspector/table/:id/close', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return closeTable(ctx, access, String(req.params.id));
  }));

  api.put('/inspector/table/:id/bet-types', handle(async (req) => {
    const { allowedBetTypeIds } = z.object({ allowedBetTypeIds: z.array(z.string()) }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    return { table: await tableView(ctx, await setTableMarkets(ctx, access, String(req.params.id), allowedBetTypeIds)) };
  }));

  api.put('/inspector/table/:id/limits', handle(async (req) => {
    const body = limitsInput.parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const current = await getTable(ctx.db, access.club.id, String(req.params.id));
    const limits: TableLimitsJson = { ...body, maxRounds: body.maxRounds ?? current.limits.maxRounds, marketMaxCents: body.marketMaxCents ?? {} };
    return { table: await tableView(ctx, await setTableLimits(ctx, access, current.id, limits)) };
  }));

  api.post('/inspector/table/:id/assign', handle(async (req) => {
    const { dealerId } = z.object({ dealerId: z.string() }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const [m] = await ctx.db.select({ roles: memberships.roles }).from(memberships)
      .where(and(eq(memberships.clubId, access.club.id), eq(memberships.userId, dealerId), eq(memberships.status, 'active')));
    if (!m?.roles.includes('dealer')) throw new AppError('dealer.not_found', 404);
    // A dealer seated elsewhere: dealer.busy_elsewhere, and the dealer gets a dealer.wanted_elsewhere notice.
    const table = await seatDealer(ctx, access.club.id, String(req.params.id), dealerId, { staff: access });
    ctx.events.emit(rooms.user(dealerId), 'dealer:seat', { status: 'assigned', tableId: table.id, tableName: table.name });
    emitTableChanged(ctx, table);
    return { table: await tableView(ctx, table) };
  }));

  api.post('/inspector/table/:id/unseat', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'floor');
    const table = await getTable(ctx.db, access.club.id, String(req.params.id));
    if (!table.dealerId) return { table: await tableView(ctx, table) };
    return { table: await tableView(ctx, await standUp(ctx, access.club.id, table.id, table.dealerId, 'floor')) };
  }));

  // ── Dealer ── routes live in modules/dealer/register.ts (seating, sit requests, console, scan).

  // ── Player ──
  api.get('/player/tables', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const list = await clubTablesList(ctx.db, access.club.id);
    return { tables: await Promise.all(list.map((t) => tableView(ctx, t))) };
  }));

  api.get('/player/table/:id', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'view');
    const table = await getTable(ctx.db, access.club.id, String(req.params.id));
    const unit = unitForTable(table.kind);
    const balanceCents = await fundsFor(unit).balance(ctx.db, { clubId: access.club.id, userId: user.id, tournamentId: table.tournamentId });
    return { table: await tableView(ctx, table), balanceCents, canPlay: can(access, 'play') && table.dealerId !== user.id };
  }));

  api.post('/player/table/:id/join', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    const table = await getTable(ctx.db, access.club.id, String(req.params.id));
    return { table: await tableView(ctx, table) };
  }));

  api.get('/player/table/:id/hands', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    await getTable(ctx.db, access.club.id, String(req.params.id));
    const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50);
    const rows = await ctx.db.select().from(hands)
      .where(and(eq(hands.tableId, String(req.params.id)), inArray(hands.status, ['settled', 'cancelled'])))
      .orderBy(desc(hands.handNumber)).limit(limit);
    return { hands: rows.map(publicHand) };
  }));

  api.post('/player/coupon', handle(async (req) => {
    const body = z.object({
      tableId: z.string(),
      rounds: z.number(),
      selections: z.array(z.object({ betTypeId: z.string().optional(), market: z.string().optional(), stakeCents: z.number() })),
    }).parse(req.body);
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return placeCoupon(ctx, access, {
      tableId: body.tableId, rounds: body.rounds,
      selections: body.selections.map((s) => ({ market: s.market ?? s.betTypeId ?? '', stakeCents: s.stakeCents })),
    });
  }));

  api.get('/player/coupons', handle(async (req) => {
    const user = currentUser(req);
    const access = await requireClub(ctx.db, req, user, 'view');
    const q = z.object({ status: z.enum(['live', 'completed', 'voided']).optional(), tableId: z.string().optional() }).parse(req.query);
    return { coupons: await playerCoupons(ctx, access.club.id, user.id, q) };
  }));

  api.get('/player/coupon/:id/draws', handle(async (req) => {
    const access = await requireClub(ctx.db, req, currentUser(req), 'view');
    return couponDraws(ctx, access, String(req.params.id), can(access, 'floor'));
  }));
}
