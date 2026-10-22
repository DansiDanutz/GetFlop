import { and, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubTables, clubs, hands } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { autoFlop, publicHand, startHand } from '../game/hands.js';
import { getTable, liveHand } from '../game/tables.js';
import { budgetState, DEFAULT_BUDGET, measureBudget } from './budget.js';
import { isSimulationClub } from './queries.js';

/** Auto-deal: start a hand, leave picks open for the interval, deal a random flop, pause, repeat. */
export const AUTO_DEAL_DEFAULT_SECONDS = 20;
export const AUTO_DEAL_PAUSE_MS = 5_000;

export const intervalMs = (t: { autoDealSeconds: number | null }): number => (t.autoDealSeconds ?? AUTO_DEAL_DEFAULT_SECONDS) * 1000;

export interface TickResult { readonly started: number; readonly dealt: number; readonly stopped: boolean }

async function tickTable(ctx: AppContext, table: typeof clubTables.$inferSelect): Promise<'started' | 'dealt' | null> {
  const now = ctx.now().getTime();
  const hand = await liveHand(ctx.db, table.id);
  if (hand) {
    if (now - hand.createdAt.getTime() < intervalMs(table)) return null;
    await autoFlop(ctx, table.clubId, table.id);
    return 'dealt';
  }
  const last = table.lastHandAt?.getTime();
  if (last !== undefined && now - last < intervalMs(table) + AUTO_DEAL_PAUSE_MS) return null;
  await startHand(ctx, table.clubId, table.id, { userId: null });
  return 'started';
}

/**
 * One pass over every open auto-deal Ring Game table. All state lives in the database
 * (live hand + its start time, last hand time), so it resumes by itself after a restart.
 * Tournament and Arena tables run their own auto-deal.
 */
export async function autoDealTick(ctx: AppContext): Promise<TickResult> {
  if ((await budgetState(ctx.db)).tripped) return { started: 0, dealt: 0, stopped: true };
  const tables = await ctx.db.select({ table: clubTables }).from(clubTables).innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(and(eq(clubTables.status, 'open'), eq(clubTables.isAutoDeal, true), eq(clubTables.kind, 'cash'), ne(clubs.status, 'deleted')));
  let started = 0;
  let dealt = 0;
  for (const { table } of tables) {
    try {
      const step = await tickTable(ctx, table);
      if (step === 'started') started += 1;
      if (step === 'dealt') dealt += 1;
    } catch (err) {
      // A refused start (billing pause …) or a race with another step is expected; anything else is logged.
      if (!(err instanceof AppError)) ctx.logger.error(`Auto-deal failed on table ${table.id}`, err);
    }
  }
  return { started, dealt, stopped: false };
}

async function assertSimulation(access: ClubAccess): Promise<void> {
  if (!isSimulationClub(access.club)) throw new AppError('simulation.club_unsupported', 403);
}

/** POST /player/table/:id/sim-step: advance one step on a simulation table (start, or deal and settle). */
export async function simStep(ctx: AppContext, access: ClubAccess, tableId: string) {
  assertCan(access, 'view');
  await assertSimulation(access);
  if ((await budgetState(ctx.db)).tripped) throw new AppError('simulation.budget_exceeded', 409);
  const table = await getTable(ctx.db, access.club.id, tableId);
  if (!table.isAutoDeal) throw new AppError('dealer.not_dealing', 403);
  const hand = await liveHand(ctx.db, table.id);
  if (hand) {
    const info = await autoFlop(ctx, table.clubId, table.id);
    return { step: 'dealt' as const, hand: publicHand(info.hand), matchingSlugs: info.matchingSlugs };
  }
  const { hand: started } = await startHand(ctx, table.clubId, table.id, { userId: null });
  return { step: 'started' as const, hand: publicHand(started), matchingSlugs: [] as string[] };
}

/** GET /inspector/simulation: budget and auto-deal tables of the simulation club. */
export async function simulationOverview(ctx: AppContext, access: ClubAccess) {
  assertCan(access, 'floor');
  await assertSimulation(access);
  const [state, measure] = await Promise.all([budgetState(ctx.db), measureBudget(ctx.db)]);
  const tables = await ctx.db.select().from(clubTables)
    .where(and(eq(clubTables.clubId, access.club.id), eq(clubTables.isAutoDeal, true), inArray(clubTables.status, ['open', 'closed'])));
  const live = tables.length === 0 ? [] : await ctx.db.select({ tableId: hands.tableId, handNumber: hands.handNumber, status: hands.status })
    .from(hands).where(and(inArray(hands.tableId, tables.map((t) => t.id)), inArray(hands.status, ['betting_open', 'betting_closed'])));
  return {
    budget: { ...state, picks: measure.picks, maxPicks: DEFAULT_BUDGET.maxPicks, dbBytes: measure.dbBytes, maxBytes: DEFAULT_BUDGET.maxBytes },
    tables: tables.map((t) => ({
      id: t.id, name: t.name, status: t.status, intervalSeconds: intervalMs(t) / 1000, lastHandNumber: t.lastHandNumber,
      liveHand: live.find((h) => h.tableId === t.id) ?? null,
    })),
  };
}
