import { and, count, countDistinct, eq, gte, inArray, lt, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { bets, clubs, clubTables, coupons, hands, pointAccounts, users } from '../../db/schema/index.js';
import { ARENA_STATUS } from '../arena/setup.js';
import type { Range } from '../inspector/time.js';

/**
 * Shared aggregates for the platform screens. Club money is only ever reported per club:
 * each club's Points are its own and are never added across clubs.
 * Real players only: bots are left out; Arena Stars are outside every club number.
 */

const SETTLED = ['won', 'lost'] as const;

const within = (column: typeof hands.settledAt | typeof coupons.createdAt, range?: Range): SQL[] =>
  range ? [gte(column, range.from), lt(column, range.to)] : [];

export interface ClubPlay {
  readonly clubId: string;
  readonly players: number;
  readonly picks: number;
  readonly playedCents: number;
  readonly wonCents: number;
}

/** Settled Ring Game picks (Points) per club in the period. */
export async function playByClub(db: DbOrTx, range?: Range): Promise<ClubPlay[]> {
  const rows = await db.select({
    clubId: bets.clubId,
    players: countDistinct(bets.userId),
    picks: count(),
    played: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`,
    won: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
  }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId))
    .innerJoin(coupons, eq(coupons.id, bets.couponId))
    .innerJoin(users, eq(users.id, bets.userId))
    .where(and(inArray(bets.status, [...SETTLED]), eq(coupons.unit, 'points'), eq(users.isBot, false), ...within(hands.settledAt, range)))
    .groupBy(bets.clubId);
  return rows.map((r) => ({ clubId: r.clubId, players: r.players, picks: r.picks, playedCents: Number(r.played), wonCents: Number(r.won) }));
}

/** Distinct real players with a settled Points pick in the period, across clubs (a head count, not money). */
export async function playersWhoPlayed(db: DbOrTx, range?: Range): Promise<number> {
  const [row] = await db.select({ n: countDistinct(bets.userId) }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(coupons, eq(coupons.id, bets.couponId))
    .innerJoin(users, eq(users.id, bets.userId))
    .where(and(inArray(bets.status, [...SETTLED]), eq(coupons.unit, 'points'), eq(users.isBot, false), ...within(hands.settledAt, range)));
  return row?.n ?? 0;
}

/** Settled Ring Game hands per club in the period. */
export async function handsByClub(db: DbOrTx, range?: Range): Promise<Map<string, number>> {
  const rows = await db.select({ clubId: hands.clubId, n: count() }).from(hands)
    .innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .where(and(eq(hands.status, 'settled'), eq(clubTables.kind, 'cash'), ...within(hands.settledAt, range)))
    .groupBy(hands.clubId);
  return new Map(rows.map((r) => [r.clubId, r.n]));
}

/** Points still riding on live coupons, per club. */
export async function ridingByClub(db: DbOrTx): Promise<Map<string, number>> {
  const rows = await db.select({ clubId: pointAccounts.clubId, total: sql<string>`coalesce(sum(${pointAccounts.balanceCents}), 0)` })
    .from(pointAccounts).where(eq(pointAccounts.kind, 'riding')).groupBy(pointAccounts.clubId);
  return new Map(rows.map((r) => [r.clubId, Number(r.total)]));
}

export async function couponsBought(db: DbOrTx, range?: Range): Promise<number> {
  const [row] = await db.select({ n: count() }).from(coupons).innerJoin(users, eq(users.id, coupons.userId))
    .where(and(eq(coupons.unit, 'points'), eq(users.isBot, false), ...within(coupons.createdAt, range)));
  return row?.n ?? 0;
}

export async function liveCoupons(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: count() }).from(coupons).innerJoin(users, eq(users.id, coupons.userId))
    .where(and(eq(coupons.status, 'live'), eq(coupons.unit, 'points'), eq(users.isBot, false)));
  return row?.n ?? 0;
}

/** Real clubs: not deleted, and not the platform Arena pseudo-club. */
export async function activeClubs(db: DbOrTx) {
  return db.select({ id: clubs.id, name: clubs.name, publicId: clubs.publicId, settings: clubs.settings })
    .from(clubs).where(notInArray(clubs.status, ['deleted', ARENA_STATUS])).orderBy(clubs.name);
}

export async function openTables(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: count() }).from(clubTables).innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(and(eq(clubTables.status, 'open'), ne(clubTables.kind, 'arena'), ne(clubs.status, 'deleted')));
  return row?.n ?? 0;
}

export interface MarketTally { readonly market: string; readonly picks: number; readonly hits: number }

/** Settled picks and hits per market across club tables (Arena Stars excluded). */
export async function marketTallies(db: DbOrTx, range?: Range): Promise<MarketTally[]> {
  return db.select({
    market: bets.market,
    picks: count(),
    hits: sql<number>`cast(count(*) filter (where ${bets.status} = 'won') as int)`,
  }).from(bets)
    .innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(coupons, eq(coupons.id, bets.couponId))
    .innerJoin(users, eq(users.id, bets.userId))
    .where(and(inArray(bets.status, [...SETTLED]), ne(coupons.unit, 'stars'), eq(users.isBot, false), ...within(hands.settledAt, range)))
    .groupBy(bets.market);
}
