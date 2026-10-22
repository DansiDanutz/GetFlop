/**
 * Background job: starts auto-start tournaments at their time and deals auto-deal
 * tournament tables (a random hand every n seconds; bots play). State lives in the
 * database, so it resumes after a restart and stops on its own when a tournament ends.
 */
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubTables, tournaments } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { autoFlop, startHand } from '../game/hands.js';
import { liveHand, type TableRow } from '../game/tables.js';
import { botsPlay } from './bots.js';
import { AUTO_DEAL_DEFAULT_SECONDS } from './rules.js';
import { startTournament } from './service.js';
import { logEvent, type TournamentRow } from './store.js';

export const AUTO_DEAL_JOB_MS = 1_000;
/** The flop shows for this long before the next hand opens (never more than a quarter of the interval). */
const REVEAL_SECONDS = 3;
const SECOND_MS = 1_000;

function revealSeconds(interval: number): number {
  return Math.min(REVEAL_SECONDS, Math.floor(interval / 4));
}

async function dealTick(ctx: AppContext, t: TournamentRow, table: TableRow, rng: () => number): Promise<'started' | 'flopped' | 'idle'> {
  const interval = table.autoDealSeconds ?? t.autoDealSeconds ?? AUTO_DEAL_DEFAULT_SECONDS;
  const now = ctx.now().getTime();
  const hand = await liveHand(ctx.db, table.id);
  if (hand) {
    if (now - hand.createdAt.getTime() < (interval - revealSeconds(interval)) * SECOND_MS) return 'idle';
    await autoFlop(ctx, t.clubId, table.id);
    return 'flopped';
  }
  if (table.lastHandAt && now - table.lastHandAt.getTime() < interval * SECOND_MS) return 'idle';
  await startHand(ctx, t.clubId, table.id, { userId: null });
  if (t.botsAllowed) await botsPlay(ctx, t, rng);
  return 'started';
}

async function autoStarts(ctx: AppContext): Promise<number> {
  const due = await ctx.db.select().from(tournaments)
    .where(and(eq(tournaments.status, 'upcoming'), eq(tournaments.autoStart, true), isNotNull(tournaments.scheduledAt), lte(tournaments.scheduledAt, ctx.now())));
  for (const t of due) {
    try {
      await startTournament(ctx, null, t.id);
    } catch (err) {
      await report(ctx, t, 'auto_start_failed', err);
    }
  }
  return due.length;
}

async function report(ctx: AppContext, t: TournamentRow, kind: string, err: unknown): Promise<void> {
  if (!(err instanceof AppError)) ctx.logger.error(`Tournament ${kind}`, err);
  await logEvent(ctx.db, t.id, kind, { code: err instanceof AppError ? err.code : 'server.error' }, err instanceof AppError ? 'warning' : 'error');
}

/** One pass of the job. Returns how many tables acted. */
export async function runTournamentJobs(ctx: AppContext, rng: () => number = Math.random): Promise<number> {
  await autoStarts(ctx);
  const rows = await ctx.db.select({ t: tournaments, table: clubTables }).from(tournaments)
    .innerJoin(clubTables, eq(clubTables.id, tournaments.tableId))
    .where(and(eq(tournaments.status, 'active'), eq(clubTables.isAutoDeal, true), eq(clubTables.status, 'open')));
  let acted = 0;
  for (const { t, table } of rows) {
    try {
      if ((await dealTick(ctx, t, table, rng)) !== 'idle') acted += 1;
    } catch (err) {
      await report(ctx, t, 'auto_deal_failed', err);
    }
  }
  return acted;
}
