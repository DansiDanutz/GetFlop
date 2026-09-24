import type { Flop } from './cards.js';
import { getMarket } from './markets.js';
import { marketMaxCents, type TableLimits } from './limits.js';

export interface CouponRequest {
  readonly markets: readonly string[];
  /** Amount per pick, per flop, in cents. */
  readonly stakeCents: number;
  /** Number of upcoming flops the coupon plays. */
  readonly rounds: number;
}

export interface CouponLeg {
  readonly market: string;
  readonly stakeCents: number;
  /** Multiplier locked at placement; later table changes never affect it. */
  readonly multiplier: number;
}

export type CouponError =
  | 'coupon_empty'
  | 'coupon_duplicate_market'
  | 'coupon_market_not_offered'
  | 'coupon_bad_rounds'
  | 'coupon_max_rounds_table'
  | 'stake_range'
  | 'coupon_over_commitment'
  | 'insufficient_balance';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function commitmentCents(req: CouponRequest): number {
  return req.markets.length * req.stakeCents * req.rounds;
}

/** Validates a coupon against the table's offered markets, limits and the player's balance. */
export function buildCoupon(
  req: CouponRequest,
  offered: ReadonlySet<string>,
  limits: TableLimits,
  balanceCents: number,
): Result<CouponLeg[], CouponError> {
  const fail = (error: CouponError): Result<CouponLeg[], CouponError> => ({ ok: false, error });
  if (req.markets.length === 0) return fail('coupon_empty');
  if (new Set(req.markets).size !== req.markets.length) return fail('coupon_duplicate_market');
  if (req.markets.some((slug) => !offered.has(slug))) return fail('coupon_market_not_offered');
  if (!Number.isInteger(req.rounds) || req.rounds < 1) return fail('coupon_bad_rounds');
  if (req.rounds > limits.maxRounds) return fail('coupon_max_rounds_table');
  const stakeOk =
    Number.isInteger(req.stakeCents) &&
    req.stakeCents >= limits.minCents &&
    req.markets.every((slug) => req.stakeCents <= marketMaxCents(slug, limits));
  if (!stakeOk) return fail('stake_range');
  const total = commitmentCents(req);
  if (total > limits.couponCapCents) return fail('coupon_over_commitment');
  if (total > balanceCents) return fail('insufficient_balance');
  return {
    ok: true,
    value: req.markets.map((market) => ({
      market,
      stakeCents: req.stakeCents,
      multiplier: getMarket(market).multiplier,
    })),
  };
}

export interface LegResult {
  readonly market: string;
  readonly won: boolean;
  readonly payoutCents: number;
}

/** Settles one flop for a coupon's legs. Payout includes the stake; cents are floored. */
export function settleRound(legs: readonly CouponLeg[], flop: Flop): LegResult[] {
  return legs.map((leg) => {
    const won = getMarket(leg.market).wins(flop);
    return { market: leg.market, won, payoutCents: won ? payoutCents(leg.stakeCents, leg.multiplier) : 0 };
  });
}

/** stake × multiplier in integer arithmetic (multipliers have at most 2 decimals). */
export function payoutCents(stakeCents: number, multiplier: number): number {
  return Math.floor((stakeCents * Math.round(multiplier * 100)) / 100);
}

/** Refund for rounds not yet played when a table closes or a coupon is voided. */
export function unplayedRefundCents(legs: readonly CouponLeg[], roundsLeft: number): number {
  return legs.reduce((sum, leg) => sum + leg.stakeCents * roundsLeft, 0);
}
