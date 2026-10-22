/**
 * The `chips` funds unit (tournament stacks) and the coupon rules of tournament tables.
 * Chips live on the player's entry: `chips` is the free stack, `chipsInPlay` the part
 * committed to live coupons.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx, Tx } from '../../db/client.js';
import { tournamentEntries } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { Funds, FundsOwner } from '../game/funds.js';
import type { CouponPreCheck, StartGuard } from '../game/hooks.js';
import { catalogue, offeredAt } from '../game/markets.js';
import { liveHand } from '../game/tables.js';
import { drawsLeft, EXPOSURE_CAP_PCT, exposureCap, levelForHand } from './rules.js';
import { findEntry, tournamentOfTable, type TournamentRow } from './store.js';

function entryWhere(o: FundsOwner) {
  if (!o.tournamentId) throw new AppError('coupon.not_registered', 403);
  return and(eq(tournamentEntries.tournamentId, o.tournamentId), eq(tournamentEntries.userId, o.userId));
}

async function adjust(tx: Tx, o: FundsOwner, freeDelta: number, inPlayDelta: number): Promise<void> {
  await tx.update(tournamentEntries).set({
    chips: sql`${tournamentEntries.chips} + ${freeDelta}`,
    chipsInPlay: sql`greatest(${tournamentEntries.chipsInPlay} + ${inPlayDelta}, 0)`,
  }).where(entryWhere(o));
}

export const chipsFunds: Funds = {
  async balance(db: DbOrTx, o: FundsOwner) {
    if (!o.tournamentId) return 0;
    return (await findEntry(db, o.tournamentId, o.userId))?.chips ?? 0;
  },
  async commit(_ctx, tx, o, amount) {
    const updated = await tx.update(tournamentEntries).set({
      chips: sql`${tournamentEntries.chips} - ${amount}`,
      chipsInPlay: sql`${tournamentEntries.chipsInPlay} + ${amount}`,
    }).where(and(entryWhere(o), gte(tournamentEntries.chips, amount))).returning({ id: tournamentEntries.id });
    if (updated.length === 0) {
      const available = await chipsFunds.balance(tx, o);
      throw new AppError('coupon.insufficient_chips', 409, { needed: amount, available });
    }
  },
  settle: (_ctx, tx, o, stake, payout) => adjust(tx, o, payout, -stake),
  refund: (_ctx, tx, o, amount) => adjust(tx, o, amount, -amount),
};

/** The tournament hand a coupon placed now would start on. */
export async function nextPlayableHand(db: DbOrTx, t: TournamentRow): Promise<number> {
  const hand = await liveHand(db, t.tableId);
  return hand?.status === 'betting_closed' ? t.handsPlayed + 2 : t.handsPlayed + 1;
}

async function checkMenu(tx: Tx, t: TournamentRow, markets: readonly string[]): Promise<void> {
  const offered = offeredAt(t.markets, await catalogue(tx));
  const missing = markets.filter((m) => !offered.has(m));
  if (missing.length > 0) throw new AppError('coupon.not_on_menu_tournament', 400, { names: missing.join(', ') });
}

/** Tournament coupon rules (docs/spec/01 §5.2, 10 §5). Runs before the engine's table checks. */
export const tournamentPreCheck: CouponPreCheck = async (_ctx, tx, { table, userId, selections, rounds }) => {
  if (table.kind !== 'tournament') return;
  const t = await tournamentOfTable(tx, table.id, table.tournamentId);
  if (!t) throw new AppError('trm.not_found', 404);
  const entry = await findEntry(tx, t.id, userId);
  if (!entry || entry.status === 'unregistered') throw new AppError('coupon.not_registered', 403);
  if (t.status !== 'active') throw new AppError('trm.not_active', 409);
  if (entry.status !== 'active') throw new AppError('coupon.not_active', 403);
  if (t.levels.length === 0) throw new AppError('coupon.levels_missing', 409);
  await checkMenu(tx, t, selections.map((s) => s.market));
  if (!Number.isInteger(rounds) || rounds < 1 || selections.length === 0) return; // engine reports these
  const startHand = await nextPlayableHand(tx, t);
  const max = drawsLeft(t.levels, t.endValue, startHand);
  if (max === 0) throw new AppError('coupon.no_draws_left', 409);
  if (rounds > max) throw new AppError('coupon.max_draws_tournament', 400, { max });
  if (selections.some((s) => !Number.isInteger(s.stakeCents) || s.stakeCents <= 0)) return; // engine: bad_stake
  const level = levelForHand(t.levels, startHand);
  const stack = entry.chips;
  const commitment = selections.reduce((sum, s) => sum + s.stakeCents, 0) * rounds;
  const shortStack = stack > 0 && stack < level.minBetChips;
  const isAllIn = shortStack && selections.length === 1 && rounds === 1 && selections[0]!.stakeCents === stack;
  if (!isAllIn) {
    for (const s of selections) {
      if (s.stakeCents < level.minBetChips) throw new AppError('coupon.min_stake', 400, { min: level.minBetChips });
      if (level.maxBetChips !== -1 && s.stakeCents > level.maxBetChips) throw new AppError('coupon.max_stake', 400, { max: level.maxBetChips });
    }
  }
  if (commitment > stack) throw new AppError('coupon.insufficient_chips', 409, { needed: commitment, available: stack });
  const cap = exposureCap(stack, level.minBetChips);
  if (!isAllIn && commitment > cap) {
    throw new AppError('coupon.over_exposure', 400, { committed: commitment, pct: EXPOSURE_CAP_PCT, stack, cap });
  }
};

/** Hands on a tournament table only while the tournament runs. */
export const tournamentStartGuard: StartGuard = async (_ctx, tx, table) => {
  if (table.kind !== 'tournament') return;
  const t = await tournamentOfTable(tx, table.id, table.tournamentId);
  if (!t || t.status !== 'active') throw new AppError('trm.not_active', 409);
  if (t.endCondition === 'hands' && t.handsPlayed >= t.endValue) throw new AppError('trm.not_active', 409);
};
