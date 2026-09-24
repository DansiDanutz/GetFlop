import { cardToString, parseFlop, randomFlop, winningMarkets, payoutCents, type Flop } from '@getflop/engine';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { bets, clubTables, couponLegs, coupons, hands, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { fundsFor } from './funds.js';
import { hooks, type BetRow, type HandRow, type SettledInfo } from './hooks.js';
import { getTable, liveHand, type TableRow } from './tables.js';

export interface HandActor {
  /** The dealer, or null when auto-dealt. */
  readonly userId: string | null;
}

async function lockTable(tx: Tx, clubId: string, tableId: string): Promise<TableRow> {
  return getTable(tx, clubId, tableId, true);
}

function assertDealer(table: TableRow, actor: HandActor): void {
  if (actor.userId === null) {
    if (!table.isAutoDeal) throw new AppError('dealer.not_dealing', 403);
    return;
  }
  if (table.dealerId !== actor.userId) throw new AppError('dealer.not_dealing', 403);
}

/** Inserts this hand's round of every eligible live coupon on the table. */
async function materializeRounds(tx: Tx, table: TableRow, hand: HandRow, couponIds?: string[]): Promise<number> {
  const conditions = [
    eq(coupons.tableId, table.id), eq(coupons.status, 'live'), lte(coupons.startHandNumber, hand.handNumber),
  ];
  if (couponIds) conditions.push(inArray(coupons.id, couponIds));
  const live = await tx.select().from(coupons).where(and(...conditions));
  if (live.length === 0) return 0;
  const legs = await tx.select().from(couponLegs)
    .where(and(inArray(couponLegs.couponId, live.map((c) => c.id)), eq(couponLegs.status, 'active')));
  const rows = live.flatMap((c) => legs.filter((l) => l.couponId === c.id).map((l) => ({
    clubId: table.clubId, handId: hand.id, couponId: c.id, legId: l.id, userId: c.userId, market: l.market,
    stakeCents: l.stakeCents, multiplierX100: l.multiplierX100, roundNumber: c.roundsSettled + 1,
  })));
  if (rows.length > 0) await tx.insert(bets).values(rows).onConflictDoNothing();
  return rows.length;
}

/** Puts a just-placed coupon on the current hand when picks are still open. */
export async function joinCurrentHand(tx: Tx, table: TableRow, couponId: string): Promise<boolean> {
  const hand = await liveHand(tx, table.id);
  if (!hand || hand.status !== 'betting_open') return false;
  await materializeRounds(tx, table, hand, [couponId]);
  return true;
}

export async function startHand(ctx: AppContext, clubId: string, tableId: string, actor: HandActor) {
  const result = await ctx.db.transaction(async (tx) => {
    const table = await lockTable(tx, clubId, tableId);
    assertDealer(table, actor);
    if (table.status !== 'open') throw new AppError('table.closed', 409);
    const current = await liveHand(tx, table.id);
    if (current) throw new AppError('dealer.hand_live', 409, { hand: current.handNumber });
    for (const guard of hooks.startGuards) await guard(ctx, tx, table);
    const handNumber = table.lastHandNumber + 1;
    const timer = ctx.config.bettingTimerSeconds;
    const [hand] = await tx.insert(hands).values({
      clubId, tableId, tournamentId: table.tournamentId, handNumber, status: 'betting_open',
      dealtBy: actor.userId ? 'dealer' : 'auto', dealerId: actor.userId,
      bettingClosesAt: timer > 0 ? new Date(ctx.now().getTime() + timer * 1000) : null,
      createdAt: ctx.now(),
    }).returning();
    await tx.update(clubTables).set({ lastHandNumber: handNumber, lastHandAt: ctx.now() }).where(eq(clubTables.id, table.id));
    await materializeRounds(tx, table, hand!);
    return { hand: hand!, table };
  });
  const bettingTimerSeconds = ctx.config.bettingTimerSeconds || null;
  ctx.events.emit(rooms.table(tableId), 'hand:started', {
    tableId, handId: result.hand.id, handNumber: result.hand.handNumber, hand: publicHand(result.hand), bettingTimerSeconds,
  });
  ctx.events.emit(rooms.staff(clubId), 'floor:changed', { tableId });
  return { hand: result.hand, bettingTimerSeconds };
}

export async function noMoreBets(ctx: AppContext, clubId: string, tableId: string, actor: HandActor | 'timer') {
  const hand = await ctx.db.transaction(async (tx) => {
    const table = await lockTable(tx, clubId, tableId);
    if (actor !== 'timer') assertDealer(table, actor);
    const current = await liveHand(tx, table.id);
    if (!current || current.status !== 'betting_open') throw new AppError('hand.not_open', 409);
    const [closed] = await tx.update(hands).set({ status: 'betting_closed', closedAt: ctx.now() })
      .where(eq(hands.id, current.id)).returning();
    return closed!;
  });
  ctx.events.emit(rooms.table(tableId), 'hand:no-more-bets', { tableId, handId: hand.id, countdown: 0 });
  ctx.events.emit(rooms.table(tableId), 'hand:betting-closed', { tableId, handId: hand.id, handNumber: hand.handNumber });
  return hand;
}

export async function cancelHand(ctx: AppContext, clubId: string, tableId: string, actor: HandActor) {
  const hand = await ctx.db.transaction(async (tx) => {
    const table = await lockTable(tx, clubId, tableId);
    assertDealer(table, actor);
    const current = await liveHand(tx, table.id);
    if (!current) throw new AppError('hand.not_live', 409);
    // No round is consumed: the materialized bets are released and the coupons play the next hand.
    await tx.update(bets).set({ status: 'refunded' }).where(and(eq(bets.handId, current.id), eq(bets.status, 'pending')));
    const [cancelled] = await tx.update(hands).set({ status: 'cancelled', cancelledAt: ctx.now() })
      .where(eq(hands.id, current.id)).returning();
    return cancelled!;
  });
  ctx.events.emit(rooms.table(tableId), 'hand:cancelled', { tableId, handId: hand.id, handNumber: hand.handNumber });
  ctx.events.emit(rooms.staff(clubId), 'floor:changed', { tableId });
  return hand;
}

/** Enters the flop and settles every pick of the hand at once. Final. */
export async function enterFlop(ctx: AppContext, clubId: string, tableId: string, actor: HandActor, cards: readonly string[]) {
  let flop: Flop;
  try {
    flop = parseFlop(cards);
  } catch {
    throw new AppError('hand.flop_invalid');
  }
  return settleHand(ctx, clubId, tableId, actor, flop);
}

/** Auto-dealt tables: a random flop from a fresh shuffle. */
export function autoFlop(ctx: AppContext, clubId: string, tableId: string) {
  return settleHand(ctx, clubId, tableId, { userId: null }, randomFlop());
}

async function settleHand(ctx: AppContext, clubId: string, tableId: string, actor: HandActor, flop: Flop) {
  const slugs = winningMarkets(flop);
  const cardCodes = flop.map(cardToString);
  const info = await ctx.db.transaction(async (tx): Promise<SettledInfo> => {
    const table = await lockTable(tx, clubId, tableId);
    assertDealer(table, actor);
    const current = await liveHand(tx, table.id);
    if (!current) throw new AppError('hand.not_live', 409);
    if (current.status === 'betting_open') {
      await tx.update(hands).set({ status: 'betting_closed', closedAt: ctx.now() }).where(eq(hands.id, current.id));
    }
    const pending = await tx.select().from(bets).where(and(eq(bets.handId, current.id), eq(bets.status, 'pending')));
    const settled = await settleBets(ctx, tx, pending, new Set(slugs));
    const wagered = settled.reduce((s, b) => s + b.stakeCents, 0);
    const paid = settled.reduce((s, b) => s + b.payoutCents, 0);
    const [hand] = await tx.update(hands).set({
      status: 'settled', card1: cardCodes[0], card2: cardCodes[1], card3: cardCodes[2], matchingSlugs: slugs,
      totalBets: settled.length, winningBets: settled.filter((b) => b.status === 'won').length,
      totalWageredCents: wagered, totalPaidOutCents: paid, settledAt: ctx.now(),
    }).where(eq(hands.id, current.id)).returning();
    await advanceCoupons(ctx, tx, settled);
    const result: SettledInfo = { table, hand: hand!, bets: settled, matchingSlugs: slugs };
    for (const hook of hooks.settled) await hook(ctx, tx, result);
    return result;
  });
  await announceSettlement(ctx, info, cardCodes);
  for (const hook of hooks.afterSettled) await hook(ctx, info);
  return info;
}

async function settleBets(ctx: AppContext, tx: Tx, pending: BetRow[], matching: ReadonlySet<string>): Promise<BetRow[]> {
  const out: BetRow[] = [];
  const unitByCoupon = new Map<string, { unit: string; tournamentId: string | null }>();
  for (const bet of pending) {
    if (!unitByCoupon.has(bet.couponId)) {
      const [c] = await tx.select({ unit: coupons.unit, tournamentId: coupons.tournamentId }).from(coupons).where(eq(coupons.id, bet.couponId));
      unitByCoupon.set(bet.couponId, c!);
    }
    const { unit, tournamentId } = unitByCoupon.get(bet.couponId)!;
    const won = matching.has(bet.market);
    const payout = won ? payoutCents(bet.stakeCents, bet.multiplierX100 / 100) : 0;
    await fundsFor(unit).settle(ctx, tx, { clubId: bet.clubId, userId: bet.userId, tournamentId, couponId: bet.couponId }, bet.stakeCents, payout, bet.id);
    const [row] = await tx.update(bets).set({ status: won ? 'won' : 'lost', payoutCents: payout }).where(eq(bets.id, bet.id)).returning();
    out.push(row!);
  }
  return out;
}

async function advanceCoupons(ctx: AppContext, tx: Tx, settled: readonly BetRow[]): Promise<void> {
  const byCoupon = new Map<string, number>();
  for (const b of settled) byCoupon.set(b.couponId, (byCoupon.get(b.couponId) ?? 0) + b.payoutCents);
  for (const [couponId, won] of byCoupon) {
    const [c] = await tx.update(coupons).set({
      roundsSettled: sql`${coupons.roundsSettled} + 1`,
      wonCents: sql`${coupons.wonCents} + ${won}`,
    }).where(eq(coupons.id, couponId)).returning();
    if (c && c.roundsSettled >= c.rounds) {
      await tx.update(coupons).set({ status: 'completed', finishedAt: ctx.now() }).where(eq(coupons.id, couponId));
    }
  }
}

async function announceSettlement(ctx: AppContext, info: SettledInfo, cardCodes: string[]): Promise<void> {
  const { table, hand } = info;
  const names = new Map<string, string>();
  const userIds = [...new Set(info.bets.map((b) => b.userId))];
  if (userIds.length > 0) {
    for (const u of await ctx.db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users)
      .where(inArray(users.id, userIds))) names.set(u.id, u.displayName ?? u.username);
  }
  const shape = (b: BetRow) => ({
    betId: b.id, userId: b.userId, username: names.get(b.userId) ?? '', betTypeSlug: b.market,
    amountCents: b.stakeCents, payoutCents: b.payoutCents, couponId: b.couponId,
  });
  const [card1, card2, card3] = cardCodes;
  ctx.events.emit(rooms.table(table.id), 'hand:flop-revealed', { tableId: table.id, handId: hand.id, card1, card2, card3 });
  ctx.events.emit(rooms.table(table.id), 'hand:settled', {
    tableId: table.id, handId: hand.id, handNumber: hand.handNumber, card1, card2, card3,
    matchingSlugs: info.matchingSlugs,
    winners: info.bets.filter((b) => b.status === 'won').map(shape),
    losers: info.bets.filter((b) => b.status === 'lost').map(shape),
    totalPaidOut: hand.totalPaidOutCents, totalWagered: hand.totalWageredCents,
    isTournament: table.kind === 'tournament',
  });
  const couponIds = [...new Set(info.bets.map((b) => b.couponId))];
  const done = couponIds.length === 0 ? [] : await ctx.db.select().from(coupons).where(inArray(coupons.id, couponIds));
  for (const c of done) {
    ctx.events.emit(rooms.user(c.userId), 'coupon:round-settled', {
      couponId: c.id, handId: hand.id, roundsSettled: c.roundsSettled, rounds: c.rounds, wonCents: c.wonCents,
    });
    if (c.status === 'completed') {
      ctx.events.emit(rooms.user(c.userId), 'coupon:completed', { couponId: c.id, wonCents: c.wonCents, committedCents: c.committedCents });
    }
  }
  for (const userId of userIds) {
    const funds = fundsFor(done.find((c) => c.userId === userId)?.unit ?? 'points');
    const balanceCents = await funds.balance(ctx.db, { clubId: table.clubId, userId, tournamentId: table.tournamentId });
    ctx.events.emit(rooms.user(userId), 'balance:updated', { clubId: table.clubId, tableId: table.id, balanceCents });
  }
  ctx.events.emit(rooms.staff(table.clubId), 'floor:changed', { tableId: table.id });
  ctx.events.emit(rooms.staff(table.clubId), 'live:changed', { clubId: table.clubId });
}

export function publicHand(h: HandRow) {
  return {
    id: h.id, handNumber: h.handNumber, status: h.status,
    flop: h.card1 ? [h.card1, h.card2, h.card3] : null, matchingSlugs: h.matchingSlugs ?? [],
    totalBets: h.totalBets, winningBets: h.winningBets, totalWageredCents: h.totalWageredCents,
    totalPaidOutCents: h.totalPaidOutCents, bettingClosesAt: h.bettingClosesAt, dealtBy: h.dealtBy,
    createdAt: h.createdAt, settledAt: h.settledAt,
  };
}

/** Closes picks on hands whose countdown ran out. Called by the background job. */
export async function closeExpiredBetting(ctx: AppContext): Promise<number> {
  const due = await ctx.db.select({ clubId: hands.clubId, tableId: hands.tableId }).from(hands)
    .where(and(eq(hands.status, 'betting_open'), lte(hands.bettingClosesAt, ctx.now())));
  for (const h of due) {
    try {
      await noMoreBets(ctx, h.clubId, h.tableId, 'timer');
    } catch (err) {
      if (!(err instanceof AppError)) ctx.logger.error('Auto close failed', err);
    }
  }
  return due.length;
}
