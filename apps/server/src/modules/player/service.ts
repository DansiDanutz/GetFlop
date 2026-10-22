import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { bets, clubTables, hands } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';
import { can, loadClubAccess } from '../clubs/access.js';
import { unitForTable } from '../game/coupons.js';
import type { TableRow } from '../game/tables.js';

/** Bet statuses that count as "played" on a hand (refunded / voided picks do not). */
const PLAYED: ReadonlyArray<'pending' | 'won' | 'lost'> = ['pending', 'won', 'lost'];

export interface HandStats {
  readonly hand: { readonly id: string; readonly handNumber: number; readonly status: string } | null;
  readonly players: number;
  readonly picks: number;
  readonly playedCents: number;
  /** The server's picks countdown length, for the countdown ring (0 = no timer). */
  readonly bettingTimerSeconds: number;
}

/**
 * Figures for the table tiles: the live hand, or the most recent hand when none
 * is live. Players = distinct people with a pick on it; picks = bets; played = Σ stakes.
 */
export async function handStats(ctx: AppContext, table: TableRow): Promise<HandStats> {
  const bettingTimerSeconds = ctx.config.bettingTimerSeconds;
  const [hand] = await ctx.db.select({ id: hands.id, handNumber: hands.handNumber, status: hands.status }).from(hands)
    .where(eq(hands.tableId, table.id)).orderBy(desc(hands.handNumber)).limit(1);
  if (!hand) return { hand: null, players: 0, picks: 0, playedCents: 0, bettingTimerSeconds };
  const rows = await ctx.db.select({ userId: bets.userId, stakeCents: bets.stakeCents }).from(bets)
    .where(and(eq(bets.handId, hand.id), inArray(bets.status, [...PLAYED])));
  return {
    hand,
    players: new Set(rows.map((r) => r.userId)).size,
    picks: rows.length,
    playedCents: rows.reduce((sum, r) => sum + r.stakeCents, 0),
    bettingTimerSeconds,
  };
}

export interface LatestSettled {
  readonly handId: string;
  readonly handNumber: number;
  readonly settledAt: Date | null;
  readonly cards: readonly string[];
  readonly matchingSlugs: readonly string[];
  readonly isTournament: boolean;
  readonly unit: string;
  /** Σ payouts of my winning picks on that hand. */
  readonly wonCents: number;
  readonly mine: ReadonlyArray<{
    readonly betId: string; readonly couponId: string; readonly market: string;
    readonly stakeCents: number; readonly payoutCents: number; readonly status: string;
  }>;
}

async function canView(db: DbOrTx, user: AuthUser, clubId: string): Promise<boolean> {
  try {
    return can(await loadClubAccess(db, user, clubId), 'view');
  } catch (err) {
    // A deleted or unknown club simply drops out of the catch-up list.
    if (err instanceof AppError) return false;
    throw err;
  }
}

async function latestFor(db: DbOrTx, user: AuthUser, table: TableRow): Promise<LatestSettled | null> {
  const [hand] = await db.select().from(hands)
    .where(and(eq(hands.tableId, table.id), eq(hands.status, 'settled'))).orderBy(desc(hands.handNumber)).limit(1);
  if (!hand?.card1) return null;
  const mine = await db.select({
    betId: bets.id, couponId: bets.couponId, market: bets.market, stakeCents: bets.stakeCents,
    payoutCents: bets.payoutCents, status: bets.status,
  }).from(bets).where(and(eq(bets.handId, hand.id), eq(bets.userId, user.id)));
  return {
    handId: hand.id, handNumber: hand.handNumber, settledAt: hand.settledAt,
    cards: [hand.card1, hand.card2!, hand.card3!], matchingSlugs: hand.matchingSlugs ?? [],
    isTournament: table.kind === 'tournament',
    unit: unitForTable(table.kind),
    wonCents: mine.reduce((sum, b) => sum + b.payoutCents, 0),
    mine,
  };
}

/**
 * Catch-up after being away: the latest settled hand of each requested table the
 * user may view (any of their clubs). Unknown, archived or foreign tables are left out.
 */
export async function latestSettled(ctx: AppContext, user: AuthUser, ids: readonly string[]): Promise<Record<string, LatestSettled>> {
  const tables = await ctx.db.select().from(clubTables).where(inArray(clubTables.id, [...ids]));
  const entries = await Promise.all(tables.filter((t) => t.status !== 'archived').map(async (table) => {
    if (!(await canView(ctx.db, user, table.clubId))) return null;
    const latest = await latestFor(ctx.db, user, table);
    return latest ? ([table.id, latest] as const) : null;
  }));
  return Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null));
}
