import { getMarket } from '@getflop/engine';
import { and, count, desc, eq, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { bets, clubs, clubTables, coupons, hands, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { unitForTable } from '../game/coupons.js';
import type { Range } from '../inspector/time.js';

/** The hand list shows the latest n hands; narrow the filters to see older ones. */
export const HANDS_LIMIT = 100;

const LIVE_STATUSES = ['betting_open', 'betting_closed'] as const;

export function marketName(slug: string): string {
  try {
    return getMarket(slug).name;
  } catch {
    return slug;
  }
}

interface HandFigures { picks: number; playedCents: number; paidCents: number }

/** Per hand: picks still counted (not refunded or voided), Points played on settled picks, and paid out. */
async function figuresByHand(db: DbOrTx, handIds: readonly string[]): Promise<Map<string, HandFigures>> {
  if (handIds.length === 0) return new Map();
  const rows = await db.select({
    handId: bets.handId,
    picks: sql<number>`cast(count(*) filter (where ${bets.status} in ('pending', 'won', 'lost')) as int)`,
    played: sql<string>`coalesce(sum(${bets.stakeCents}) filter (where ${bets.status} in ('won', 'lost')), 0)`,
    paid: sql<string>`coalesce(sum(${bets.payoutCents}) filter (where ${bets.status} = 'won'), 0)`,
  }).from(bets).where(inArray(bets.handId, [...handIds])).groupBy(bets.handId);
  return new Map(rows.map((r) => [r.handId, { picks: r.picks, playedCents: Number(r.played), paidCents: Number(r.paid) }]));
}

/** Every table across clubs, for the hand-history picker. */
export async function allTables(ctx: AppContext) {
  const rows = await ctx.db.select({ table: clubTables, clubName: clubs.name }).from(clubTables)
    .innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(and(ne(clubTables.status, 'archived'), ne(clubs.status, 'deleted')))
    .orderBy(clubs.name, clubTables.name);
  return {
    tables: rows.map(({ table, clubName }) => ({
      id: table.id, name: table.name, clubId: table.clubId, clubName, kind: table.kind, status: table.status,
      unit: unitForTable(table.kind), lastHandNumber: table.lastHandNumber, lastHandAt: table.lastHandAt,
    })),
  };
}

export interface HandsQuery {
  readonly tableId?: string;
  readonly handNumber?: number;
  readonly range?: Range;
}

export async function listHands(ctx: AppContext, q: HandsQuery) {
  const conditions: SQL[] = [];
  if (q.tableId) conditions.push(eq(hands.tableId, q.tableId));
  if (q.handNumber !== undefined) conditions.push(eq(hands.handNumber, q.handNumber));
  if (q.range) conditions.push(gte(hands.createdAt, q.range.from), lt(hands.createdAt, q.range.to));
  const rows = await ctx.db.select({ hand: hands, tableName: clubTables.name, tableKind: clubTables.kind, clubName: clubs.name })
    .from(hands).innerJoin(clubTables, eq(clubTables.id, hands.tableId)).innerJoin(clubs, eq(clubs.id, hands.clubId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(hands.createdAt), desc(hands.handNumber)).limit(HANDS_LIMIT);
  const figures = await figuresByHand(ctx.db, rows.map((r) => r.hand.id));
  return {
    limit: HANDS_LIMIT,
    truncated: rows.length === HANDS_LIMIT,
    hands: rows.map(({ hand, tableName, tableKind, clubName }) => {
      const f = figures.get(hand.id) ?? { picks: 0, playedCents: 0, paidCents: 0 };
      return {
        id: hand.id, clubId: hand.clubId, clubName, tableId: hand.tableId, tableName, tableKind, unit: unitForTable(tableKind),
        handNumber: hand.handNumber, status: hand.status, flop: hand.card1 ? [hand.card1, hand.card2, hand.card3] : null,
        ...f, resultCents: f.playedCents - f.paidCents, createdAt: hand.createdAt, settledAt: hand.settledAt,
      };
    }),
  };
}

/** Every pick of one hand with its player. */
export async function handBets(ctx: AppContext, handId: string) {
  const [row] = await ctx.db.select({ hand: hands, tableName: clubTables.name, tableKind: clubTables.kind, clubName: clubs.name })
    .from(hands).innerJoin(clubTables, eq(clubTables.id, hands.tableId)).innerJoin(clubs, eq(clubs.id, hands.clubId))
    .where(eq(hands.id, handId)).limit(1);
  if (!row) throw new AppError('admin.hand_not_found', 404);
  const rows = await ctx.db.select({ bet: bets, username: users.username, displayName: users.displayName, unit: coupons.unit })
    .from(bets).innerJoin(users, eq(users.id, bets.userId)).innerJoin(coupons, eq(coupons.id, bets.couponId))
    .where(eq(bets.handId, handId)).orderBy(users.username, bets.market);
  const { hand } = row;
  return {
    hand: {
      id: hand.id, clubId: hand.clubId, clubName: row.clubName, tableId: hand.tableId, tableName: row.tableName,
      tableKind: row.tableKind, handNumber: hand.handNumber, status: hand.status,
      flop: hand.card1 ? [hand.card1, hand.card2, hand.card3] : null, createdAt: hand.createdAt,
    },
    bets: rows.map(({ bet, username, displayName, unit }) => ({
      id: bet.id, userId: bet.userId, username, displayName: displayName ?? username, market: bet.market,
      marketName: marketName(bet.market), stakeCents: bet.stakeCents, multiplier: bet.multiplierX100 / 100,
      status: bet.status, payoutCents: bet.payoutCents, voidReason: bet.voidReason, unit, couponId: bet.couponId,
      roundNumber: bet.roundNumber,
    })),
  };
}

/** Open tables across clubs with the hand in play and the live coupons riding on them. */
export async function liveOverview(ctx: AppContext) {
  const tables = await ctx.db.select({ table: clubTables, clubName: clubs.name, dealerName: users.displayName, dealerUsername: users.username })
    .from(clubTables).innerJoin(clubs, eq(clubs.id, clubTables.clubId)).leftJoin(users, eq(users.id, clubTables.dealerId))
    .where(and(eq(clubTables.status, 'open'), ne(clubs.status, 'deleted'))).orderBy(clubs.name, clubTables.name);
  const ids = tables.map((t) => t.table.id);
  const liveHands = ids.length === 0 ? [] : await ctx.db.select().from(hands)
    .where(and(inArray(hands.tableId, ids), inArray(hands.status, [...LIVE_STATUSES])));
  const pending = liveHands.length === 0 ? [] : await ctx.db.select({
    handId: bets.handId, picks: count(), stake: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`,
  }).from(bets).where(and(inArray(bets.handId, liveHands.map((h) => h.id)), eq(bets.status, 'pending'))).groupBy(bets.handId);
  const couponCounts = ids.length === 0 ? [] : await ctx.db.select({ tableId: coupons.tableId, n: count() }).from(coupons)
    .where(and(inArray(coupons.tableId, ids), eq(coupons.status, 'live'))).groupBy(coupons.tableId);
  const rows = tables.map(({ table, clubName, dealerName, dealerUsername }) => {
    const hand = liveHands.find((h) => h.tableId === table.id);
    const p = hand ? pending.find((x) => x.handId === hand.id) : undefined;
    return {
      tableId: table.id, name: table.name, clubId: table.clubId, clubName, kind: table.kind, unit: unitForTable(table.kind),
      dealerName: dealerName ?? dealerUsername ?? null, isAutoDeal: table.isAutoDeal,
      liveCoupons: couponCounts.find((c) => c.tableId === table.id)?.n ?? 0,
      hand: hand ? { id: hand.id, handNumber: hand.handNumber, status: hand.status, picks: p?.picks ?? 0, stakeCents: Number(p?.stake ?? 0) } : null,
    };
  });
  return {
    tables: rows,
    totals: {
      tablesOpen: rows.length,
      liveHands: rows.filter((r) => r.hand).length,
      pendingPicks: rows.reduce((s, r) => s + (r.hand?.picks ?? 0), 0),
      pendingStakeCents: rows.filter((r) => r.unit === 'points').reduce((s, r) => s + (r.hand?.stakeCents ?? 0), 0),
      liveCoupons: rows.reduce((s, r) => s + r.liveCoupons, 0),
    },
  };
}
