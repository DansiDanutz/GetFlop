import { and, eq, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { arenaBadges, arenaPlayers, arenaState, arenaStats } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';
import type { BetRow, SettledInfo } from '../game/hooks.js';
import { catalogue, offeredAt } from '../game/markets.js';
import { advanceProgress, earnedBadges, type BadgeCode, type FlopSummary } from './badges.js';
import { arenaConfig } from './config.js';
import { ARENA_KIND } from './setup.js';
import { starBalance } from './stars.js';
import { dayKey, periodKeys, weekKey } from './time.js';

export const FLOP_COUNTER_KEY = 'flops_all_time';

/** Summarises one player's picks on a settled flop. */
export function summarise(bets: readonly BetRow[]): FlopSummary {
  const won = bets.filter((b) => b.status === 'won');
  return {
    stakeCents: bets.reduce((s, b) => s + b.stakeCents, 0),
    paidCents: bets.reduce((s, b) => s + b.payoutCents, 0),
    picks: bets.length,
    picksWon: won.length,
    markets: [...new Set(bets.map((b) => b.market))],
    marketsWon: [...new Set(won.map((b) => b.market))],
    bestWinX100: Math.max(0, ...won.map((b) => b.multiplierX100)),
  };
}

function biggestWin(bets: readonly BetRow[]): { cents: number; x100: number } {
  return bets.filter((b) => b.status === 'won')
    .reduce((best, b) => (b.payoutCents > best.cents ? { cents: b.payoutCents, x100: b.multiplierX100 } : best), { cents: 0, x100: 0 });
}

async function addStats(tx: Tx, userId: string, period: string, bets: readonly BetRow[], now: Date): Promise<void> {
  const s = summarise(bets);
  const hit = biggestWin(bets);
  const net = s.paidCents - s.stakeCents;
  const flopWon = s.picksWon > 0 ? 1 : 0;
  await tx.insert(arenaStats).values({
    userId, period, flops: 1, flopsWon: flopWon, picks: s.picks, picksWon: s.picksWon, wageredCents: s.stakeCents,
    paidCents: s.paidCents, netCents: net, biggestHitCents: hit.cents, biggestHitX100: hit.x100, updatedAt: now,
  }).onConflictDoUpdate({
    target: [arenaStats.userId, arenaStats.period],
    set: {
      flops: sql`${arenaStats.flops} + 1`,
      flopsWon: sql`${arenaStats.flopsWon} + ${flopWon}`,
      picks: sql`${arenaStats.picks} + ${s.picks}`,
      picksWon: sql`${arenaStats.picksWon} + ${s.picksWon}`,
      wageredCents: sql`${arenaStats.wageredCents} + ${s.stakeCents}`,
      paidCents: sql`${arenaStats.paidCents} + ${s.paidCents}`,
      netCents: sql`${arenaStats.netCents} + ${net}`,
      biggestHitX100: sql`case when ${hit.cents} > ${arenaStats.biggestHitCents} then ${hit.x100} else ${arenaStats.biggestHitX100} end`,
      biggestHitCents: sql`greatest(${arenaStats.biggestHitCents}, ${hit.cents})`,
      updatedAt: now,
    },
  });
}

/** Inserts badges not yet held; returns the new ones. */
export async function grantBadges(tx: DbOrTx, userId: string, codes: readonly BadgeCode[], now: Date): Promise<BadgeCode[]> {
  if (codes.length === 0) return [];
  const held = await tx.select({ code: arenaBadges.code }).from(arenaBadges)
    .where(and(eq(arenaBadges.userId, userId), inArray(arenaBadges.code, [...codes])));
  const fresh = codes.filter((c) => !held.some((h) => h.code === c));
  if (fresh.length > 0) await tx.insert(arenaBadges).values(fresh.map((code) => ({ userId, code, earnedAt: now })));
  return fresh;
}

async function bumpFlopCounter(tx: Tx, now: Date): Promise<void> {
  await tx.insert(arenaState).values({ key: FLOP_COUNTER_KEY, value: 1, updatedAt: now }).onConflictDoUpdate({
    target: arenaState.key, set: { value: sql`to_jsonb((${arenaState.value})::text::bigint + 1)`, updatedAt: now },
  });
}

async function playerFlop(ctx: AppContext, tx: Tx, userId: string, mine: readonly BetRow[], offered: readonly string[]): Promise<BadgeCode[]> {
  const cfg = arenaConfig();
  const now = ctx.now();
  const keys = periodKeys(now, cfg.timeZone);
  for (const period of [keys.week, keys.month, keys.all]) await addStats(tx, userId, period, mine, now);
  const [player] = await tx.select().from(arenaPlayers).where(eq(arenaPlayers.userId, userId)).for('update');
  if (!player) return [];
  const { comeback, ...next } = advanceProgress(player, summarise(mine), {
    day: dayKey(now, cfg.timeZone), week: weekKey(now, cfg.timeZone), balanceCents: await starBalance(tx, userId),
    comebackFloorCents: cfg.comebackFloorCents, comebackPeakCents: cfg.comebackPeakCents,
  });
  await tx.update(arenaPlayers).set({ ...next, marketsPlayed: [...next.marketsPlayed], marketsWon: [...next.marketsWon] })
    .where(eq(arenaPlayers.userId, userId));
  return grantBadges(tx, userId, earnedBadges(next, { offered, comeback }), now);
}

/** New badges per hand, emitted after the settlement commits. */
const pendingBadges = new Map<string, Map<string, BadgeCode[]>>();

/** Settled hook (inside the settlement transaction): board aggregates, progress and badges. */
export async function onArenaSettled(ctx: AppContext, tx: Tx, info: SettledInfo): Promise<void> {
  if (info.table.kind !== ARENA_KIND) return;
  await bumpFlopCounter(tx, ctx.now());
  if (info.bets.length === 0) return;
  const offered = [...offeredAt(info.table.markets, await catalogue(tx))];
  const earned = new Map<string, BadgeCode[]>();
  for (const userId of new Set(info.bets.map((b) => b.userId))) {
    const fresh = await playerFlop(ctx, tx, userId, info.bets.filter((b) => b.userId === userId), offered);
    if (fresh.length > 0) earned.set(userId, fresh);
  }
  if (earned.size > 0) pendingBadges.set(info.hand.id, earned);
}

/** After-commit hook: tells each player about the badges this flop earned. */
export function announceBadges(ctx: AppContext, info: SettledInfo): void {
  const earned = pendingBadges.get(info.hand.id);
  if (!earned) return;
  pendingBadges.delete(info.hand.id);
  for (const [userId, badges] of earned) ctx.events.emit(rooms.user(userId), 'arena:badges', { badges });
}

export async function flopCounter(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ value: arenaState.value }).from(arenaState).where(eq(arenaState.key, FLOP_COUNTER_KEY));
  return Number(row?.value ?? 0);
}
