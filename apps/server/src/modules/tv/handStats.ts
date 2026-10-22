import { MARKETS } from '@getflop/engine';
import { and, count, countDistinct, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { bets, hands } from '../../db/schema/index.js';
import { LIVE_HAND } from '../game/tables.js';
import { POPULAR_MARKETS, RECENT_FLOPS } from './constants.js';

type HandRow = typeof hands.$inferSelect;

/** Bets that were really played on a hand (refunded / voided ones are not). */
const PLAYED = ['pending', 'won', 'lost'] as const;
const NAMES = new Map(MARKETS.map((m) => [m.slug, m.name]));
export const marketName = (slug: string): string => NAMES.get(slug) ?? slug;

const cardsOf = (h: HandRow): string[] | null => (h.card1 && h.card2 && h.card3 ? [h.card1, h.card2, h.card3] : null);

/** The live hand, else the latest hand of the table (settled or cancelled), else null. */
export async function currentHand(db: DbOrTx, where: { tableId?: string; tournamentId?: string }): Promise<HandRow | null> {
  const scope = where.tableId ? eq(hands.tableId, where.tableId) : eq(hands.tournamentId, where.tournamentId ?? '');
  const [live] = await db.select().from(hands).where(and(scope, inArray(hands.status, [...LIVE_HAND] as HandRow['status'][]))).limit(1);
  if (live) return live;
  const [latest] = await db.select().from(hands).where(scope).orderBy(desc(hands.handNumber)).limit(1);
  return latest ?? null;
}

/** Aggregate totals only: counts and sums, never who played what. */
async function totals(db: DbOrTx, handId: string) {
  const [row] = await db.select({
    bets: count(),
    players: countDistinct(bets.userId),
    staked: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`,
    paid: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
    winners: sql<string>`count(distinct ${bets.userId}) filter (where ${bets.status} = 'won')`,
  }).from(bets).where(and(eq(bets.handId, handId), inArray(bets.status, [...PLAYED])));
  return {
    bets: Number(row?.bets ?? 0), players: Number(row?.players ?? 0), stakedCents: Number(row?.staked ?? 0),
    paidOutCents: Number(row?.paid ?? 0), winners: Number(row?.winners ?? 0),
  };
}

export interface TvHand {
  readonly handNumber: number;
  readonly status: string;
  readonly cards: string[] | null;
  readonly winningMarkets: { slug: string; name: string }[];
  readonly bettingClosesAt: Date | null;
  readonly players: number;
  readonly bets: number;
  readonly stakedCents: number;
  readonly paidOutCents: number;
  readonly winners: number;
}

export async function tvHand(db: DbOrTx, hand: HandRow): Promise<TvHand> {
  const settled = hand.status === 'settled';
  return {
    handNumber: hand.handNumber,
    status: hand.status,
    cards: settled ? cardsOf(hand) : null,
    winningMarkets: settled ? (hand.matchingSlugs ?? []).map((slug) => ({ slug, name: marketName(slug) })) : [],
    bettingClosesAt: hand.status === 'betting_open' ? hand.bettingClosesAt : null,
    ...(await totals(db, hand.id)),
  };
}

/** Most picked markets of a hand: pick and player counts per market, no names. */
export async function popularMarkets(db: DbOrTx, handId: string) {
  const rows = await db.select({ market: bets.market, picks: count(), players: countDistinct(bets.userId) })
    .from(bets).where(and(eq(bets.handId, handId), inArray(bets.status, [...PLAYED]))).groupBy(bets.market);
  return rows
    .map((r) => ({ slug: r.market, name: marketName(r.market), picks: Number(r.picks), players: Number(r.players) }))
    .sort((a, b) => b.picks - a.picks || b.players - a.players || a.slug.localeCompare(b.slug))
    .slice(0, POPULAR_MARKETS);
}

/** The last settled flops of a table, newest first. */
export async function recentFlops(db: DbOrTx, tableId: string) {
  const list = await db.select().from(hands).where(and(eq(hands.tableId, tableId), eq(hands.status, 'settled')))
    .orderBy(desc(hands.handNumber)).limit(RECENT_FLOPS);
  return list.map((h) => ({ handNumber: h.handNumber, cards: cardsOf(h), winningMarkets: h.matchingSlugs ?? [] }));
}
