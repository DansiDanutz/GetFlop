import { sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { AppError } from '../../http/errors.js';
import { readFlag, rowsOf, writeFlag } from './queries.js';

/** Simulation budget guard (07 §7): at most 200,000 stored picks or a 1 GB database. */
export interface BudgetLimits {
  readonly maxPicks: number;
  readonly maxBytes: number;
}

export const DEFAULT_BUDGET: BudgetLimits = { maxPicks: 200_000, maxBytes: 1024 ** 3 };
const FLAG = 'sim_budget';

export interface BudgetState {
  readonly tripped: boolean;
  readonly trippedAt: string | null;
  readonly reason: 'picks' | 'database' | null;
}

export interface BudgetMeasure {
  readonly picks: number;
  /** null when the database size cannot be read. */
  readonly dbBytes: number | null;
}

export async function budgetState(db: DbOrTx): Promise<BudgetState> {
  const flag = await readFlag<Partial<BudgetState>>(db, FLAG);
  return { tripped: flag?.tripped === true, trippedAt: flag?.trippedAt ?? null, reason: flag?.reason ?? null };
}

/** Stored picks in simulation clubs, and the database size. */
export async function measureBudget(db: DbOrTx): Promise<BudgetMeasure> {
  const [picks] = rowsOf<{ n: string | number }>(await db.execute(sql`
    select count(*) as n from bets b join clubs c on c.id = b.club_id where (c.settings ->> 'simulation') = 'true'`));
  let dbBytes: number | null = null;
  try {
    const [size] = rowsOf<{ bytes: string | number }>(await db.execute(sql`select pg_database_size(current_database()) as bytes`));
    dbBytes = size ? Number(size.bytes) : null;
  } catch {
    dbBytes = null;
  }
  return { picks: Number(picks?.n ?? 0), dbBytes };
}

function overReason(m: BudgetMeasure, limits: BudgetLimits): BudgetState['reason'] {
  if (m.picks > limits.maxPicks) return 'picks';
  if (m.dbBytes !== null && m.dbBytes > limits.maxBytes) return 'database';
  return null;
}

/** Trips the guard when over budget (auto-deal stops everywhere). Never un-trips by itself. */
export async function checkBudget(ctx: AppContext, limits: BudgetLimits = DEFAULT_BUDGET): Promise<BudgetState> {
  const state = await budgetState(ctx.db);
  if (state.tripped) return state;
  const reason = overReason(await measureBudget(ctx.db), limits);
  if (!reason) return state;
  const tripped: BudgetState = { tripped: true, trippedAt: ctx.now().toISOString(), reason };
  await writeFlag(ctx.db, FLAG, { ...tripped }, ctx.now());
  ctx.logger.info('Simulation budget reached: auto-deal stopped', { reason });
  return tripped;
}

/** Lets auto-deal run again; refused while still over the limit. */
export async function releaseBudget(ctx: AppContext, limits: BudgetLimits = DEFAULT_BUDGET): Promise<BudgetState> {
  const measure = await measureBudget(ctx.db);
  if (overReason(measure, limits)) {
    throw new AppError('simulation.budget_exceeded', 409, { picks: measure.picks, maxPicks: limits.maxPicks });
  }
  const released: BudgetState = { tripped: false, trippedAt: null, reason: null };
  await writeFlag(ctx.db, FLAG, { ...released }, ctx.now());
  return released;
}
