import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { arenaBadges, clubTables } from '../../db/schema/index.js';
import { catalogue, offeredAt } from '../game/markets.js';
import { ALL_BADGES, badgeProgress, EMPTY_PROGRESS, groupOf, type Progress } from './badges.js';
import { findPlayer } from './players.js';
import { ensureArena } from './setup.js';

/** GET /arena/medals: every badge, earned or locked, with "next badge" progress. */
export async function medals(ctx: AppContext, userId: string) {
  const { tableId } = await ensureArena(ctx);
  const player = await findPlayer(ctx.db, userId);
  const progress: Progress = player ?? EMPTY_PROGRESS;
  const held = await ctx.db.select().from(arenaBadges).where(eq(arenaBadges.userId, userId));
  const [table] = await ctx.db.select({ markets: clubTables.markets }).from(clubTables).where(eq(clubTables.id, tableId));
  const offeredCount = offeredAt(table?.markets ?? [], await catalogue(ctx.db)).size;
  const times = Object.fromEntries(held.map((b) => [b.code, b.times]));
  const badges = ALL_BADGES.map((code) => {
    const mine = held.find((b) => b.code === code);
    return {
      code, group: groupOf(code), earned: Boolean(mine), earnedAt: mine?.earnedAt ?? null, times: mine?.times ?? 0,
      progress: badgeProgress(code, progress, offeredCount, times),
    };
  });
  return { badges, earnedCount: held.length, totalCount: ALL_BADGES.length };
}
