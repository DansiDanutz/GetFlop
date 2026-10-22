import { getMarket } from '@getflop/engine';
import { and, count, countDistinct, eq, gte, inArray, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { arenaPlayers, bets, hands, starLedger, starOrders } from '../../db/schema/index.js';
import { rankedRows, periodKey } from './board.js';
import { arenaConfig, DAY_MS, STAR_PACKS } from './config.js';
import { ensureArena } from './setup.js';
import { starSupply } from './stars.js';
import { flopCounter } from './stats.js';
import { dayStart, monthStart, weekStart } from './time.js';

export type ReportPeriod = 'day' | 'week' | 'month' | 'all';
/** Below this many hands the hold is "Not enough yet". */
const MIN_HANDS_FOR_HOLD = 20;

function periodStart(period: ReportPeriod, now: Date, timeZone: string): Date | null {
  if (period === 'day') return dayStart(now, timeZone);
  if (period === 'week') return weekStart(now, timeZone);
  if (period === 'month') return monthStart(now, timeZone);
  return null;
}

async function issuedByKind(db: DbOrTx, since: Date | null): Promise<Record<string, number>> {
  const where = since ? and(inArray(starLedger.kind, ['welcome', 'refill', 'purchase']), gte(starLedger.createdAt, since))
    : inArray(starLedger.kind, ['welcome', 'refill', 'purchase']);
  const rows = await db.select({ kind: starLedger.kind, n: sql<string>`coalesce(sum(${starLedger.amountCents}), 0)` })
    .from(starLedger).where(where).groupBy(starLedger.kind);
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}

async function sales(db: DbOrTx, since: Date | null) {
  const paid = since ? and(eq(starOrders.status, 'paid'), gte(starOrders.paidAt, since)) : eq(starOrders.status, 'paid');
  const [totals] = await db.select({
    orders: count(), buyers: countDistinct(starOrders.userId),
    charged: sql<string>`coalesce(sum(${starOrders.totalCents}), 0)`, vat: sql<string>`coalesce(sum(${starOrders.vatCents}), 0)`,
    kept: sql<string>`coalesce(sum(${starOrders.priceCents}), 0)`,
  }).from(starOrders).where(paid);
  const perPack = await db.select({ packId: starOrders.packId, orders: count(), stars: sql<string>`coalesce(sum(${starOrders.starsCents}), 0)` })
    .from(starOrders).where(paid).groupBy(starOrders.packId);
  return {
    orders: totals?.orders ?? 0, buyers: totals?.buyers ?? 0, chargedCents: Number(totals?.charged ?? 0),
    vatCents: Number(totals?.vat ?? 0), keptCents: Number(totals?.kept ?? 0),
    packs: STAR_PACKS.map((p) => {
      const row = perPack.find((r) => r.packId === p.id);
      return { id: p.id, orders: row?.orders ?? 0, starsCents: Number(row?.stars ?? 0) };
    }),
  };
}

async function play(db: DbOrTx, clubId: string, since: Date) {
  const settled = and(eq(hands.clubId, clubId), eq(hands.status, 'settled'), gte(hands.settledAt, since));
  const [totals] = await db.select({
    hands: count(), played: sql<string>`coalesce(sum(${hands.totalWageredCents}), 0)`, paid: sql<string>`coalesce(sum(${hands.totalPaidOutCents}), 0)`,
  }).from(hands).where(settled);
  const markets = await db.select({
    market: bets.market, picks: count(), won: sql<number>`count(*) filter (where ${bets.status} = 'won')`,
    wagered: sql<string>`coalesce(sum(${bets.stakeCents}), 0)`, paid: sql<string>`coalesce(sum(${bets.payoutCents}), 0)`,
  }).from(bets).innerJoin(hands, eq(hands.id, bets.handId)).where(settled).groupBy(bets.market);
  const played = Number(totals?.played ?? 0);
  const paid = Number(totals?.paid ?? 0);
  const handCount = totals?.hands ?? 0;
  return {
    hands: handCount, playedCents: played, paidCents: paid, holdCents: played - paid,
    holdPct: handCount >= MIN_HANDS_FOR_HOLD && played > 0 ? Math.round(((played - paid) / played) * 10_000) / 100 : null,
    markets: markets.map((m) => ({
      slug: m.market, picks: m.picks, won: Number(m.won),
      returnPct: Number(m.wagered) > 0 ? Math.round((Number(m.paid) / Number(m.wagered)) * 10_000) / 100 : null,
      pricedMultiplier: safeMultiplier(m.market),
    })).sort((a, b) => b.picks - a.picks),
  };
}

function safeMultiplier(slug: string): number | null {
  try { return getMarket(slug).multiplier; } catch { return null; }
}

async function weekBoard(ctx: AppContext) {
  const rows = await rankedRows(ctx.db, periodKey('week', ctx.now(), arenaConfig().timeZone));
  return {
    players: rows.length,
    flops: rows.reduce((s, r) => s + r.flops, 0),
    wins: rows.reduce((s, r) => s + r.flopsWon, 0),
    hidden: rows.filter((r) => r.hidden).length,
  };
}

/** GET /admin/platform/arena: the Arena, outside every club and commercial figure. */
export async function arenaReport(ctx: AppContext, period: ReportPeriod) {
  const cfg = arenaConfig();
  const now = ctx.now();
  const { clubId } = await ensureArena(ctx);
  const since = periodStart(period, now, cfg.timeZone);
  const retentionStart = new Date(now.getTime() - cfg.retentionDays * DAY_MS);
  const playSince = since && since > retentionStart ? since : retentionStart;
  const allTime = await issuedByKind(ctx.db, null);
  const inPeriod = await issuedByKind(ctx.db, since);
  const supply = await starSupply(ctx.db);
  const granted = (allTime.welcome ?? 0) + (allTime.refill ?? 0);
  const [players] = await ctx.db.select({ n: count() }).from(arenaPlayers);
  return {
    period,
    since: since?.toISOString() ?? null,
    players: players?.n ?? 0,
    stars: {
      allTime: {
        grantedCents: granted, boughtCents: allTime.purchase ?? 0, inWalletsCents: supply.inWallets, ridingCents: supply.riding,
        houseHoldsCents: granted + (allTime.purchase ?? 0) - supply.inWallets, driftCents: supply.drift,
      },
      period: { grantedCents: inPeriod.welcome ?? 0, refilledCents: inPeriod.refill ?? 0, boughtCents: inPeriod.purchase ?? 0 },
    },
    sales: await sales(ctx.db, since),
    play: { ...(await play(ctx.db, clubId, playSince)), since: playSince.toISOString(), retentionDays: cfg.retentionDays, flopsAllTime: await flopCounter(ctx.db) },
    board: await weekBoard(ctx),
  };
}
