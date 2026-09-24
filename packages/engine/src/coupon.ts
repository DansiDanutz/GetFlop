import type { Flop } from './cards.js';
import { getMarket } from './markets.js';
import { marketMaxCents, type TableLimits } from './limits.js';

export interface Selection {
  readonly market: string;
  /** Amount per flop for this pick, in cents. */
  readonly stakeCents: number;
}

export interface CouponRequest {
  readonly selections: readonly Selection[];
  /** Number of upcoming flops the coupon plays. */
  readonly rounds: number;
}

export interface CouponLeg extends Selection {
  /** Multiplier locked at placement; later price changes never affect it. */
  readonly multiplier: number;
}

export type CouponError =
  | 'coupon.no_selections'
  | 'coupon.duplicate_selections'
  | 'coupon.not_on_menu_table'
  | 'coupon.bad_rounds'
  | 'coupon.max_rounds_table'
  | 'coupon.bad_stake'
  | 'coupon.min_stake'
  | 'coupon.max_stake'
  | 'coupon.max_stake_market'
  | 'coupon.over_commitment'
  | 'coupon.insufficient_balance';

export interface CouponFailure {
  readonly error: CouponError;
  readonly params?: Readonly<Record<string, string | number>>;
}

export type Result<T, E> = { ok: true; value: T } | ({ ok: false } & E);

export function commitmentCents(req: CouponRequest): number {
  return req.selections.reduce((sum, s) => sum + s.stakeCents, 0) * req.rounds;
}

export interface CouponContext {
  /** Markets offered at this table. */
  readonly offered: ReadonlySet<string>;
  readonly limits: TableLimits;
  readonly balanceCents: number;
  /** Multiplier per market currently in force (defaults to the catalogue). */
  readonly multiplierOf?: (slug: string) => number;
  /** Tournaments and the Arena skip the per-coupon cap. */
  readonly skipCommitmentCap?: boolean;
}

/** Validates a coupon in the server's order and locks each leg's multiplier. */
export function buildCoupon(req: CouponRequest, ctx: CouponContext): Result<CouponLeg[], CouponFailure> {
  const fail = (error: CouponError, params?: CouponFailure['params']) => ({ ok: false as const, error, params });
  const { selections, rounds } = req;
  const { limits } = ctx;
  if (selections.length === 0) return fail('coupon.no_selections');
  if (new Set(selections.map((s) => s.market)).size !== selections.length) return fail('coupon.duplicate_selections');
  const missing = selections.filter((s) => !ctx.offered.has(s.market)).map((s) => s.market);
  if (missing.length > 0) return fail('coupon.not_on_menu_table', { names: missing.join(', ') });
  if (!Number.isInteger(rounds) || rounds < 1) return fail('coupon.bad_rounds');
  if (rounds > limits.maxRounds) return fail('coupon.max_rounds_table', { max: limits.maxRounds });
  for (const s of selections) {
    if (!Number.isInteger(s.stakeCents) || s.stakeCents <= 0) return fail('coupon.bad_stake');
    if (s.stakeCents < limits.minCents) return fail('coupon.min_stake', { min: limits.minCents });
    if (s.stakeCents > limits.maxCents) return fail('coupon.max_stake', { max: limits.maxCents });
    const marketMax = marketMaxCents(s.market, limits);
    if (s.stakeCents > marketMax) return fail('coupon.max_stake_market', { name: s.market, max: marketMax });
  }
  const total = commitmentCents(req);
  if (!ctx.skipCommitmentCap && total > limits.couponCapCents) {
    return fail('coupon.over_commitment', { total, max: limits.couponCapCents });
  }
  if (total > ctx.balanceCents) return fail('coupon.insufficient_balance');
  const multiplierOf = ctx.multiplierOf ?? ((slug: string) => getMarket(slug).multiplier);
  return { ok: true, value: selections.map((s) => ({ ...s, multiplier: multiplierOf(s.market) })) };
}

export interface LegResult {
  readonly market: string;
  readonly won: boolean;
  readonly payoutCents: number;
}

/** stake + floor(stake × odds), in integer arithmetic (multipliers have at most 2 decimals). */
export function payoutCents(stakeCents: number, multiplier: number): number {
  return Math.floor((stakeCents * Math.round(multiplier * 100)) / 100);
}

/** Settles one flop for a coupon's legs. Payout includes the stake. */
export function settleRound(legs: readonly CouponLeg[], flop: Flop): LegResult[] {
  return legs.map((leg) => {
    const won = getMarket(leg.market).wins(flop);
    return { market: leg.market, won, payoutCents: won ? payoutCents(leg.stakeCents, leg.multiplier) : 0 };
  });
}

/** Refund for rounds not yet played when a table closes or a coupon is voided. */
export function unplayedRefundCents(legs: readonly Selection[], roundsLeft: number): number {
  return legs.reduce((sum, leg) => sum + leg.stakeCents * roundsLeft, 0);
}

/** Upper bound shown on the slip: every pick wins on every flop. */
export function topWinCents(legs: readonly CouponLeg[], rounds: number): number {
  return legs.reduce((sum, leg) => sum + payoutCents(leg.stakeCents, leg.multiplier), 0) * rounds;
}
