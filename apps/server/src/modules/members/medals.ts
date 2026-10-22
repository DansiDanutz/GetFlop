import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, clubTables, coupons, hands, ledgerEntries } from '../../db/schema/index.js';
import type { ClubAccess } from '../clubs/access.js';
import { assertMember } from './board.js';

const WEEK_MS = 7 * 86_400_000;

export interface Medal {
  readonly code: string; readonly earned: boolean; readonly progress: number; readonly target: number; readonly remaining: number;
}

const medal = (code: string, progress: number, target: number): Medal => ({
  code, earned: progress >= target && target > 0, progress: Math.min(progress, target), target, remaining: Math.max(0, target - progress),
});

/** Longest run of consecutive weeks (week start instants) in a sorted list. */
export function longestWeekRun(weekStarts: readonly number[]): number {
  let best = 0;
  let run = 0;
  let previous: number | null = null;
  for (const week of [...new Set(weekStarts)].sort((a, b) => a - b)) {
    run = previous !== null && Math.round((week - previous) / WEEK_MS) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    previous = week;
  }
  return best;
}

/** Club medals with progress toward each (03 §11). Ring Game Points flops only. */
export async function clubMedals(ctx: AppContext, access: ClubAccess) {
  assertMember(access);
  const clubId = access.club.id;
  const userId = access.user.id;
  const played = and(eq(bets.clubId, clubId), eq(bets.userId, userId), eq(coupons.unit, 'points'),
    inArray(bets.status, ['won', 'lost']), eq(hands.status, 'settled'));
  const [flops] = await ctx.db.select({ n: sql<string>`count(distinct ${bets.handId})`, tables: sql<string>`count(distinct ${hands.tableId})` })
    .from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId)).where(played);
  const [tables] = await ctx.db.select({ n: sql<string>`count(*)` }).from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.kind, 'cash'), ne(clubTables.status, 'archived')));
  const [buyins] = await ctx.db.select({ n: sql<string>`count(*)` }).from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), eq(ledgerEntries.userId, userId), eq(ledgerEntries.kind, 'tournament_buyin')));
  const weeks = await ctx.db.selectDistinct({ week: sql<string>`date_trunc('week', ${hands.settledAt})` })
    .from(bets).innerJoin(coupons, eq(coupons.id, bets.couponId)).innerJoin(hands, eq(hands.id, bets.handId)).where(played);
  const flopCount = Number(flops?.n ?? 0);
  const tableTotal = Number(tables?.n ?? 0);
  return {
    medals: [
      medal('first_flop', flopCount, 1),
      medal('flops_10', flopCount, 10),
      medal('flops_100', flopCount, 100),
      medal('every_table', Number(flops?.tables ?? 0), tableTotal),
      medal('first_tournament', Number(buyins?.n ?? 0), 1),
      medal('four_weeks', longestWeekRun(weeks.map((w) => new Date(w.week).getTime())), 4),
    ],
  };
}
