import { and, count, desc, eq, gt, inArray, lt, or } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { arenaPlayers, bets, clubTables, coupons, hands } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { HandRow } from '../game/hooks.js';
import { autoFlop, noMoreBets, startHand } from '../game/hands.js';
import { liveHand, type TableRow } from '../game/tables.js';
import { arenaConfig, DAY_MS, type ArenaConfig } from './config.js';
import { ARENA_KIND, ensureArena } from './setup.js';

/** open: picks open · closing: no more picks, flop coming · result: showing the last flop · asleep: nobody here. */
export type DealPhase = 'open' | 'closing' | 'result' | 'asleep';

export interface DealClock {
  readonly phase: DealPhase;
  /** Length of the current phase. */
  readonly windowMs: number;
  readonly remainingMs: number;
  /** When the current phase ends (null while asleep). */
  readonly endsAt: string | null;
}

export interface TableState {
  readonly live: HandRow | null;
  readonly lastSettledAt: Date | null;
  readonly awake: boolean;
}

function clockUntil(phase: DealPhase, windowMs: number, end: number, now: Date): DealClock {
  return { phase, windowMs, remainingMs: Math.max(0, end - now.getTime()), endsAt: new Date(end).toISOString() };
}

/** Where the deal cycle stands. Derived from the database only, so it resumes after a restart. */
export function dealClock(state: TableState, now: Date, cfg: ArenaConfig): DealClock {
  const { live } = state;
  if (live?.status === 'betting_open') {
    const end = live.bettingClosesAt?.getTime() ?? live.createdAt.getTime() + cfg.windowMs;
    return clockUntil('open', cfg.windowMs, end, now);
  }
  if (live?.status === 'betting_closed') {
    return clockUntil('closing', cfg.closingMs, (live.closedAt ?? now).getTime() + cfg.closingMs, now);
  }
  if (!state.awake) return { phase: 'asleep', windowMs: 0, remainingMs: 0, endsAt: null };
  return clockUntil('result', cfg.resultMs, (state.lastSettledAt?.getTime() ?? 0) + cfg.resultMs, now);
}

export type DealAction = 'close' | 'flop' | 'start' | null;

export function nextAction(clock: DealClock): DealAction {
  if (clock.remainingMs > 0) return null;
  if (clock.phase === 'open') return 'close';
  if (clock.phase === 'closing') return 'flop';
  if (clock.phase === 'result') return 'start';
  return null;
}

/** Awake while someone sat recently or a coupon is still live on the table. */
export async function isAwake(db: DbOrTx, tableId: string, now: Date, cfg: ArenaConfig): Promise<boolean> {
  const since = new Date(now.getTime() - cfg.presenceMs);
  const [seen] = await db.select({ n: count() }).from(arenaPlayers)
    .where(and(eq(arenaPlayers.lastTableId, tableId), gt(arenaPlayers.lastSeenAt, since)));
  if ((seen?.n ?? 0) > 0) return true;
  const [live] = await db.select({ n: count() }).from(coupons).where(and(eq(coupons.tableId, tableId), eq(coupons.status, 'live')));
  return (live?.n ?? 0) > 0;
}

export async function tableState(db: DbOrTx, tableId: string, now: Date, cfg: ArenaConfig): Promise<TableState> {
  const [last] = await db.select({ at: hands.settledAt, cancelledAt: hands.cancelledAt }).from(hands)
    .where(and(eq(hands.tableId, tableId), inArray(hands.status, ['settled', 'cancelled'])))
    .orderBy(desc(hands.handNumber)).limit(1);
  return {
    live: await liveHand(db, tableId),
    lastSettledAt: last?.at ?? last?.cancelledAt ?? null,
    awake: await isAwake(db, tableId, now, cfg),
  };
}

async function startArenaHand(ctx: AppContext, table: TableRow, cfg: ArenaConfig): Promise<void> {
  const { hand } = await startHand(ctx, table.clubId, table.id, { userId: null });
  await ctx.db.update(hands).set({ bettingClosesAt: new Date(hand.createdAt.getTime() + cfg.windowMs) }).where(eq(hands.id, hand.id));
}

/** Runs the one step that is due on this table, if any. Returns what it did. */
export async function tickTable(ctx: AppContext, table: TableRow): Promise<DealAction> {
  const cfg = arenaConfig();
  const action = nextAction(dealClock(await tableState(ctx.db, table.id, ctx.now(), cfg), ctx.now(), cfg));
  try {
    if (action === 'close') await noMoreBets(ctx, table.clubId, table.id, 'timer');
    else if (action === 'flop') await autoFlop(ctx, table.clubId, table.id);
    else if (action === 'start') await startArenaHand(ctx, table, cfg);
  } catch (err) {
    // Another worker (or the generic countdown job) moved the hand first: the next tick picks it up.
    if (err instanceof AppError) return null;
    throw err;
  }
  return action;
}

export async function openArenaTables(db: DbOrTx, clubId: string): Promise<TableRow[]> {
  return db.select().from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.kind, ARENA_KIND), eq(clubTables.status, 'open'), eq(clubTables.isAutoDeal, true)));
}

/** The auto-deal job: start hand → betting window → close → random flop → result pause → next. */
export async function runArenaDeal(ctx: AppContext): Promise<DealAction[]> {
  if (!arenaConfig().open) return [];
  const { clubId } = await ensureArena(ctx);
  const done: DealAction[] = [];
  for (const table of await openArenaTables(ctx.db, clubId)) {
    try {
      done.push(await tickTable(ctx, table));
    } catch (err) {
      ctx.logger.error(`Arena deal failed on table ${table.id}`, err);
    }
  }
  return done;
}

/** Deletes Arena hands older than the retention window (the all-time flop counter lives in arena_state). */
export async function purgeOldArenaHands(ctx: AppContext): Promise<number> {
  const { clubId } = await ensureArena(ctx);
  const cutoff = new Date(ctx.now().getTime() - arenaConfig().retentionDays * DAY_MS);
  return ctx.db.transaction(async (tx) => {
    const old = await tx.select({ id: hands.id }).from(hands).where(and(
      eq(hands.clubId, clubId),
      or(and(eq(hands.status, 'settled'), lt(hands.settledAt, cutoff)), and(eq(hands.status, 'cancelled'), lt(hands.cancelledAt, cutoff))),
    ));
    if (old.length === 0) return 0;
    const ids = old.map((h) => h.id);
    await tx.delete(bets).where(inArray(bets.handId, ids));
    await tx.delete(hands).where(inArray(hands.id, ids));
    return ids.length;
  });
}
