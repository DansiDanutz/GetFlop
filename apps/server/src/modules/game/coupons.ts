import { buildCoupon, commitmentCents, type Selection } from '@getflop/engine';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, clubTables, couponLegs, coupons, hands, memberships } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { fundsFor, type Unit } from './funds.js';
import { joinCurrentHand } from './hands.js';
import { hooks } from './hooks.js';
import { catalogue, offeredAt, toEngineLimits } from './markets.js';
import { getTable, liveHand } from './tables.js';

export interface PlaceCouponInput {
  readonly tableId: string;
  readonly selections: readonly Selection[];
  readonly rounds: number;
}

export function unitForTable(kind: string): Unit {
  if (kind === 'tournament') return 'chips';
  if (kind === 'arena') return 'stars';
  return 'points';
}

export async function placeCoupon(ctx: AppContext, access: ClubAccess, input: PlaceCouponInput) {
  assertCan(access, 'play');
  const clubId = access.club.id;
  const userId = access.user.id;
  const placed = await ctx.db.transaction(async (tx) => {
    const table = await getTable(tx, clubId, input.tableId).catch(() => {
      throw new AppError('coupon.table_not_found', 404);
    });
    if (table.status !== 'open') throw new AppError('coupon.table_closed', 409);
    if (!table.couponsEnabled) throw new AppError('coupon.table_closed', 409);
    if (table.dealerId === userId) throw new AppError('coupon.dealer_own_table', 403);
    const unit = unitForTable(table.kind);
    const funds = fundsFor(unit);
    const owner = { clubId, userId, tournamentId: table.tournamentId };
    const cat = await catalogue(tx);
    const unavailable = input.selections.filter((s) => !cat.get(s.market)?.active);
    if (unavailable.length > 0) throw new AppError('coupon.selection_unavailable', 409, { names: unavailable.map((s) => s.market).join(', ') });
    const built = buildCoupon(input, {
      offered: offeredAt(table.markets, cat),
      limits: toEngineLimits(table.limits),
      balanceCents: await funds.balance(tx, owner),
      multiplierOf: (slug) => (cat.get(slug)?.multiplierX100 ?? 0) / 100,
      skipCommitmentCap: unit !== 'points',
    });
    if (!built.ok) throw new AppError(built.error, 400, built.params);
    const commitment = commitmentCents(input);
    for (const guard of hooks.couponGuards) await guard(ctx, tx, { table, userId, commitment, rounds: input.rounds });
    const current = await liveHand(tx, table.id);
    const startHandNumber = current?.status === 'betting_open' ? current.handNumber : table.lastHandNumber + 1;
    const [coupon] = await tx.insert(coupons).values({
      clubId, tableId: table.id, tournamentId: table.tournamentId, userId, unit, rounds: input.rounds,
      committedCents: commitment, startHandNumber, createdAt: ctx.now(),
    }).returning();
    await tx.insert(couponLegs).values(built.value.map((leg) => ({
      couponId: coupon!.id, market: leg.market, stakeCents: leg.stakeCents, multiplierX100: Math.round(leg.multiplier * 100),
    })));
    await funds.commit(ctx, tx, { ...owner, couponId: coupon!.id }, commitment);
    const playsCurrentHand = await joinCurrentHand(tx, table, coupon!.id);
    await tx.update(memberships).set({ lastPlayedAt: ctx.now() })
      .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId)));
    return { coupon: coupon!, unit, playsCurrentHand, balanceCents: await funds.balance(tx, owner), table };
  });
  ctx.events.emit(rooms.table(input.tableId), 'coupon:placed', {
    tableId: input.tableId, couponId: placed.coupon.id, picks: input.selections.length, playsCurrentHand: placed.playsCurrentHand,
  });
  ctx.events.emit(rooms.user(userId), 'balance:updated', { clubId, tableId: input.tableId, balanceCents: placed.balanceCents });
  ctx.events.emit(rooms.staff(clubId), 'live:changed', { clubId });
  return {
    couponId: placed.coupon.id, rounds: placed.coupon.rounds, totalCommitmentCents: placed.coupon.committedCents,
    balanceCents: placed.balanceCents, unit: placed.unit, isTournament: placed.unit === 'chips',
    playsCurrentHand: placed.playsCurrentHand,
  };
}

export type CouponRow = typeof coupons.$inferSelect;

/** Coupon summaries with their legs, newest first. */
export async function couponSummaries(ctx: AppContext, rows: CouponRow[]) {
  if (rows.length === 0) return [];
  const ids = rows.map((c) => c.id);
  const legs = await ctx.db.select().from(couponLegs).where(inArray(couponLegs.couponId, ids));
  const tables = await ctx.db.select({ id: clubTables.id, name: clubTables.name }).from(clubTables)
    .where(inArray(clubTables.id, [...new Set(rows.map((c) => c.tableId))]));
  return rows.map((c) => {
    const mine = legs.filter((l) => l.couponId === c.id);
    const perRound = mine.filter((l) => l.status === 'active').reduce((s, l) => s + l.stakeCents, 0);
    return {
      id: c.id, tableId: c.tableId, tableName: tables.find((t) => t.id === c.tableId)?.name ?? '',
      unit: c.unit, status: c.status, rounds: c.rounds, roundsSettled: c.roundsSettled,
      committedCents: c.committedCents, wonCents: c.wonCents, refundedCents: c.refundedCents,
      stillAtStakeCents: c.status === 'live' ? perRound * (c.rounds - c.roundsSettled) : 0,
      createdAt: c.createdAt, finishedAt: c.finishedAt,
      picks: mine.map((l) => ({ market: l.market, stakeCents: l.stakeCents, multiplier: l.multiplierX100 / 100, status: l.status })),
    };
  });
}

export async function playerCoupons(ctx: AppContext, clubId: string, userId: string, opts: { status?: string; tableId?: string; limit?: number }) {
  const conditions = [eq(coupons.clubId, clubId), eq(coupons.userId, userId)];
  if (opts.status) conditions.push(eq(coupons.status, opts.status as CouponRow['status']));
  if (opts.tableId) conditions.push(eq(coupons.tableId, opts.tableId));
  const rows = await ctx.db.select().from(coupons).where(and(...conditions)).orderBy(desc(coupons.createdAt)).limit(opts.limit ?? 50);
  return couponSummaries(ctx, rows);
}

/** Flop-by-flop view of one coupon (the player's own, or any for staff). */
export async function couponDraws(ctx: AppContext, access: ClubAccess, couponId: string, staff = false) {
  const [coupon] = await ctx.db.select().from(coupons).where(and(eq(coupons.id, couponId), eq(coupons.clubId, access.club.id))).limit(1);
  if (!coupon || (!staff && coupon.userId !== access.user.id)) throw new AppError('coupon.not_found', 404);
  const rows = await ctx.db.select({ bet: bets, hand: hands }).from(bets).innerJoin(hands, eq(hands.id, bets.handId))
    .where(eq(bets.couponId, couponId)).orderBy(hands.handNumber);
  const byHand = new Map<string, { handNumber: number; status: string; flop: string[] | null; picks: unknown[] }>();
  for (const { bet, hand } of rows) {
    const entry = byHand.get(hand.id) ?? {
      handNumber: hand.handNumber, status: hand.status,
      flop: hand.card1 ? [hand.card1, hand.card2!, hand.card3!] : null, picks: [],
    };
    entry.picks.push({ market: bet.market, stakeCents: bet.stakeCents, status: bet.status, payoutCents: bet.payoutCents });
    byHand.set(hand.id, entry);
  }
  const [summary] = await couponSummaries(ctx, [coupon]);
  return { coupon: summary, draws: [...byHand.values()] };
}
