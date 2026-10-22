import { allFlops, MARKETS } from '@getflop/engine';
import { and, count, desc, eq, gte, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../../db/client.js';
import type { AppContext } from '../../context.js';
import { bets, coupons, hands, ledgerEntries, pointAccounts, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { couponDraws, couponSummaries } from '../game/coupons.js';
import { account, balanceOf, stock, wallet } from '../points/ledger.js';
import { assertMemberViewer } from './list.js';
import type { DateRange } from './range.js';
import { loadMember, nameOf } from './shared.js';

const MOVEMENTS_SHOWN = 20;
export const COUPON_PAGE = 20;
const SENT_OUT_KINDS = ['deposit', 'reload'];
const CLAIMED_BACK_KINDS = ['withdrawal', 'cashout'];

let expected: Map<string, number> | null = null;
/** Probability of each market over every possible flop (computed once). */
export function expectedRates(): Map<string, number> {
  if (expected) return expected;
  const flops = allFlops();
  expected = new Map(MARKETS.map((m) => [m.slug, flops.filter((f) => m.wins(f)).length / flops.length]));
  return expected;
}

export interface Figures {
  hands: number; playedCents: number; wonCents: number; resultCents: number; sentOutCents: number; claimedBackCents: number;
}

async function figures(db: DbOrTx, clubId: string, userId: string, range: DateRange | null): Promise<Figures> {
  const inRange = (col: typeof hands.settledAt | typeof ledgerEntries.createdAt): SQL[] =>
    range ? [gte(col, range.start), lt(col, range.end)] : [];
  const [play] = await db.select({
    hands: sql<string>`count(distinct ${bets.handId})`,
    played: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`,
    won: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
  }).from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId))
    .where(and(eq(bets.clubId, clubId), eq(bets.userId, userId), eq(coupons.unit, 'points'),
      inArray(bets.status, ['won', 'lost']), eq(hands.status, 'settled'), ...inRange(hands.settledAt)));
  const [moves] = await db.select({
    sent: sql<string>`coalesce(sum(case when ${inArray(ledgerEntries.kind, SENT_OUT_KINDS)} then ${ledgerEntries.amountCents} else 0 end), 0)`,
    back: sql<string>`coalesce(sum(case when ${inArray(ledgerEntries.kind, CLAIMED_BACK_KINDS)} then ${ledgerEntries.amountCents} else 0 end), 0)`,
  }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), eq(ledgerEntries.userId, userId), ...inRange(ledgerEntries.createdAt)));
  const playedCents = Number(play?.played ?? 0);
  const wonCents = Number(play?.won ?? 0);
  return {
    hands: Number(play?.hands ?? 0), playedCents, wonCents, resultCents: playedCents - wonCents,
    sentOutCents: Number(moves?.sent ?? 0), claimedBackCents: Number(moves?.back ?? 0),
  };
}

/** "Where they play": per market, settled picks, Points played and actual vs expected hit rate. */
async function marketFigures(db: DbOrTx, clubId: string, userId: string, range: DateRange | null) {
  const rows = await db.select({
    market: bets.market, picks: count(), played: sql<string>`sum(${bets.stakeCents})`,
    hits: sql<string>`sum(case when ${bets.status} = 'won' then 1 else 0 end)`,
  }).from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId))
    .where(and(eq(bets.clubId, clubId), eq(bets.userId, userId), eq(coupons.unit, 'points'), inArray(bets.status, ['won', 'lost']),
      ...(range ? [gte(hands.settledAt, range.start), lt(hands.settledAt, range.end)] : [])))
    .groupBy(bets.market);
  const rates = expectedRates();
  return rows.map((r) => ({
    market: r.market, picks: r.picks, playedCents: Number(r.played), hits: Number(r.hits),
    hitRate: r.picks > 0 ? Number(r.hits) / r.picks : 0, expectedRate: rates.get(r.market) ?? null,
  })).sort((a, b) => b.playedCents - a.playedCents);
}

/** Latest wallet and stock movements, with who did them. Signed from the member's side. */
async function movements(db: DbOrTx, clubId: string, userId: string) {
  const mine = await db.select({ id: pointAccounts.id, kind: pointAccounts.kind }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.userId, userId), inArray(pointAccounts.kind, ['player', 'stock'])));
  if (mine.length === 0) return [];
  const ids = mine.map((a) => a.id);
  const actor = alias(users, 'actor');
  const rows = await db.select({ entry: ledgerEntries, actor: { id: actor.id, username: actor.username, displayName: actor.displayName } })
    .from(ledgerEntries).leftJoin(actor, eq(actor.id, ledgerEntries.actorId))
    .where(and(eq(ledgerEntries.clubId, clubId), or(inArray(ledgerEntries.fromAccountId, ids), inArray(ledgerEntries.toAccountId, ids))))
    .orderBy(desc(ledgerEntries.createdAt), desc(sql.raw(`"ledger_entries".ctid`))).limit(MOVEMENTS_SHOWN);
  return rows.map(({ entry: e, actor: a }) => {
    const incoming = ids.includes(e.toAccountId ?? '');
    const accountId = incoming ? e.toAccountId : e.fromAccountId;
    return {
      id: e.id, kind: e.kind, createdAt: e.createdAt, note: e.note,
      account: mine.find((m) => m.id === accountId)?.kind === 'stock' ? 'stock' : 'wallet',
      amountCents: incoming ? e.amountCents : -e.amountCents,
      balanceAfterCents: incoming ? e.toBalanceAfter : e.fromBalanceAfter,
      actor: a?.id ? { userId: a.id, name: nameOf({ username: a.username ?? '', displayName: a.displayName }), isSelf: a.id === userId } : null,
    };
  });
}

export async function memberCard(ctx: AppContext, access: ClubAccess, userId: string, range: DateRange | null) {
  assertMemberViewer(access);
  const clubId = access.club.id;
  const { membership: m, user: u } = await loadMember(ctx.db, clubId, userId);
  await account(ctx.db, clubId, wallet(userId));
  const [period, all, markets, recent, balanceCents] = await Promise.all([
    range ? figures(ctx.db, clubId, userId, range) : null,
    figures(ctx.db, clubId, userId, null),
    marketFigures(ctx.db, clubId, userId, range),
    movements(ctx.db, clubId, userId),
    balanceOf(ctx.db, clubId, wallet(userId)),
  ]);
  const stockCents = m.roles.includes('inspector') ? await balanceOf(ctx.db, clubId, stock(userId)) : undefined;
  return {
    member: {
      userId: u.id, username: u.username, displayName: nameOf(u), roles: m.roles, playMode: m.playMode, status: m.status,
      via: m.via, joinedAt: m.reviewedAt ?? m.createdAt, lastPlayedAt: m.lastPlayedAt, balanceCents,
      ...(stockCents === undefined ? {} : { stockCents }),
    },
    stats: { period: period ?? all, all },
    range: range ? { start: range.start, end: range.end } : null,
    markets, movements: recent,
  };
}

export async function memberCoupons(ctx: AppContext, access: ClubAccess, userId: string, range: DateRange | null, offset: number) {
  assertMemberViewer(access);
  const clubId = access.club.id;
  await loadMember(ctx.db, clubId, userId, ['active', 'left', 'removed']);
  const rows = await ctx.db.select().from(coupons)
    .where(and(eq(coupons.clubId, clubId), eq(coupons.userId, userId),
      ...(range ? [gte(coupons.createdAt, range.start), lt(coupons.createdAt, range.end)] : [])))
    .orderBy(desc(coupons.createdAt)).limit(COUPON_PAGE + 1).offset(offset);
  return { coupons: await couponSummaries(ctx, rows.slice(0, COUPON_PAGE)), more: rows.length > COUPON_PAGE };
}

export async function memberCoupon(ctx: AppContext, access: ClubAccess, userId: string, couponId: string) {
  assertMemberViewer(access);
  const [row] = await ctx.db.select({ id: coupons.id }).from(coupons)
    .where(and(eq(coupons.id, couponId), eq(coupons.clubId, access.club.id), eq(coupons.userId, userId))).limit(1);
  if (!row) throw new AppError('coupon.not_found', 404);
  return couponDraws(ctx, access, couponId, true);
}
