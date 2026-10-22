import { and, eq, gt, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { arenaBadges, arenaPlayers, arenaState, arenaStats, arenaWeekAwards, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { BadgeCode } from './badges.js';
import { arenaConfig } from './config.js';
import { findPlayer } from './players.js';
import { addDays, nextMonthStart, nextWeekStart, periodKeys, weekKey } from './time.js';

export type BoardPeriod = 'week' | 'month' | 'all';
export type Title = 'champion' | 'veteran' | 'sharpshooter';

const TOP_ROWS = 50;
const PODIUM = 3;
const VETERAN_FLOPS = 1_000;
const SHARPSHOOTER_FLOPS = 50;
const SHARPSHOOTER_RATE = 0.5;
const LAST_CLOSED_KEY = 'last_closed_week';
const CHAMPION_KEY = 'champion';

export interface RankedRow {
  readonly userId: string;
  readonly username: string;
  readonly hidden: boolean;
  readonly flops: number;
  readonly flopsWon: number;
  readonly netCents: number;
  readonly biggestHitCents: number;
  readonly biggestHitX100: number;
  readonly totalFlops: number;
  readonly lifetimeWon: number;
}

/** Ranking: net ★ first, then more flops, then username for a stable order. */
export function compareRows(a: Pick<RankedRow, 'netCents' | 'flops' | 'username'>, b: Pick<RankedRow, 'netCents' | 'flops' | 'username'>): number {
  return b.netCents - a.netCents || b.flops - a.flops || a.username.localeCompare(b.username);
}

export async function rankedRows(db: DbOrTx, period: string): Promise<RankedRow[]> {
  const rows = await db.select({
    userId: arenaStats.userId, username: users.username, hidden: arenaPlayers.boardHidden,
    flops: arenaStats.flops, flopsWon: arenaStats.flopsWon, netCents: arenaStats.netCents,
    biggestHitCents: arenaStats.biggestHitCents, biggestHitX100: arenaStats.biggestHitX100,
    totalFlops: arenaPlayers.totalFlops, lifetimeWon: arenaPlayers.flopsWon,
  }).from(arenaStats)
    .innerJoin(users, eq(users.id, arenaStats.userId))
    .innerJoin(arenaPlayers, eq(arenaPlayers.userId, arenaStats.userId))
    .where(and(eq(arenaStats.period, period), gt(arenaStats.flops, 0)));
  return [...rows].sort(compareRows);
}

export function periodKey(period: BoardPeriod, now: Date, timeZone: string): string {
  const keys = periodKeys(now, timeZone);
  return period === 'week' ? keys.week : period === 'month' ? keys.month : keys.all;
}

async function stateValue<T>(db: DbOrTx, key: string): Promise<T | null> {
  const [row] = await db.select({ value: arenaState.value }).from(arenaState).where(eq(arenaState.key, key));
  return (row?.value as T | undefined) ?? null;
}

async function setState(db: DbOrTx, key: string, value: unknown, now: Date): Promise<void> {
  await db.insert(arenaState).values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: arenaState.key, set: { value, updatedAt: now } });
}

function titlesFor(row: RankedRow, championId: string | null): Title[] {
  const titles: Title[] = [];
  if (row.userId === championId) titles.push('champion');
  if (row.totalFlops >= VETERAN_FLOPS) titles.push('veteran');
  if (row.totalFlops >= SHARPSHOOTER_FLOPS && row.lifetimeWon / row.totalFlops >= SHARPSHOOTER_RATE) titles.push('sharpshooter');
  return titles;
}

export interface BoardEntry {
  readonly rank: number;
  /** null when the player hid their name ("Player" in the UI). */
  readonly username: string | null;
  readonly hidden: boolean;
  readonly flops: number;
  readonly netCents: number;
  readonly me: boolean;
  readonly titles: Title[];
}

function closesAt(period: BoardPeriod, now: Date, timeZone: string): string | null {
  if (period === 'week') return nextWeekStart(now, timeZone).toISOString();
  if (period === 'month') return nextMonthStart(now, timeZone).toISOString();
  return null;
}

/** GET /arena/board: podium, top rows, my row and the biggest hit of the period. */
export async function board(ctx: AppContext, userId: string, period: BoardPeriod) {
  const cfg = arenaConfig();
  const now = ctx.now();
  const rows = await rankedRows(ctx.db, periodKey(period, now, cfg.timeZone));
  const champion = await stateValue<{ userId: string }>(ctx.db, CHAMPION_KEY);
  const entry = (r: RankedRow, i: number): BoardEntry => ({
    rank: i + 1, username: r.hidden && r.userId !== userId ? null : r.username, hidden: r.hidden,
    flops: r.flops, netCents: r.netCents, me: r.userId === userId, titles: titlesFor(r, champion?.userId ?? null),
  });
  const entries = rows.map(entry);
  const mine = entries.find((e) => e.me) ?? null;
  const hit = rows.reduce<RankedRow | null>((best, r) => (r.biggestHitCents > (best?.biggestHitCents ?? 0) ? r : best), null);
  const player = await findPlayer(ctx.db, userId);
  return {
    period,
    weekOf: weekKey(now, cfg.timeZone),
    closesAt: closesAt(period, now, cfg.timeZone),
    players: entries.length,
    podium: entries.slice(0, PODIUM),
    top: entries.slice(0, TOP_ROWS),
    me: mine,
    meHidden: player?.boardHidden ?? false,
    hasPlayed: (player?.totalFlops ?? 0) > 0,
    biggestHit: hit ? {
      username: hit.hidden && hit.userId !== userId ? null : hit.username, hidden: hit.hidden,
      multiplier: hit.biggestHitX100 / 100, starsCents: hit.biggestHitCents,
    } : null,
  };
}

/** My place this week (null before my first flop of the week). */
export async function weekRank(ctx: AppContext, userId: string): Promise<number | null> {
  const cfg = arenaConfig();
  const rows = await rankedRows(ctx.db, periodKey('week', ctx.now(), cfg.timeZone));
  const i = rows.findIndex((r) => r.userId === userId);
  return i < 0 ? null : i + 1;
}

export async function setBoardHidden(ctx: AppContext, userId: string, hidden: boolean): Promise<{ hidden: boolean }> {
  const player = await findPlayer(ctx.db, userId);
  if (!player || player.totalFlops === 0) throw new AppError('arena.not_played', 409);
  await ctx.db.update(arenaPlayers).set({ boardHidden: hidden }).where(eq(arenaPlayers.userId, userId));
  return { hidden };
}

const WEEK_BADGES: readonly [BadgeCode, number][] = [['week_top10', 10], ['week_top3', 3], ['week_first', 1]];

async function awardWeekBadge(db: DbOrTx, userId: string, code: BadgeCode, now: Date): Promise<void> {
  await db.insert(arenaBadges).values({ userId, code, earnedAt: now, times: 1 }).onConflictDoUpdate({
    target: [arenaBadges.userId, arenaBadges.code], set: { times: sql`${arenaBadges.times} + 1`, earnedAt: now },
  });
}

/** Closes finished weeks (Monday 00:00 platform time): weekly badges and the week's champion. Idempotent. */
export async function closeWeeks(ctx: AppContext): Promise<string | null> {
  const cfg = arenaConfig();
  const now = ctx.now();
  const previous = addDays(weekKey(now, cfg.timeZone), -7);
  const lastClosed = await stateValue<string>(ctx.db, LAST_CLOSED_KEY);
  if (lastClosed && lastClosed >= previous) return null;
  const earned = await ctx.db.transaction(async (tx) => {
    const rows = (await rankedRows(tx, `w:${previous}`)).slice(0, 10);
    const already = await tx.select({ userId: arenaWeekAwards.userId }).from(arenaWeekAwards).where(eq(arenaWeekAwards.week, previous));
    const out = new Map<string, BadgeCode[]>();
    if (already.length === 0) {
      for (const [i, row] of rows.entries()) {
        const codes = WEEK_BADGES.filter(([, top]) => i < top).map(([code]) => code);
        for (const code of codes) await awardWeekBadge(tx, row.userId, code, now);
        await tx.insert(arenaWeekAwards).values({ week: previous, userId: row.userId, rank: i + 1, netCents: row.netCents });
        out.set(row.userId, codes);
      }
      if (rows[0]) await setState(tx, CHAMPION_KEY, { userId: rows[0].userId, week: previous }, now);
    }
    await setState(tx, LAST_CLOSED_KEY, previous, now);
    return out;
  });
  for (const [userId, badges] of earned) ctx.events.emit(rooms.user(userId), 'arena:badges', { badges, week: previous });
  return previous;
}
