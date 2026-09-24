import { getMarket } from './markets.js';

/** All amounts are integer cents of a Point (100 = 1 PTS). */
export interface TableLimits {
  readonly minCents: number;
  readonly maxCents: number;
  readonly couponCapCents: number;
  readonly maxRounds: number;
  /** Explicit per-market maximum; a market left out uses its automatic limit. */
  readonly marketMaxCents: Readonly<Record<string, number>>;
}

export const DEFAULT_LIMITS: TableLimits = {
  minCents: 100,
  maxCents: 5_000,
  couponCapCents: 20_000,
  maxRounds: 20, // inferred default; configurable per table
  marketMaxCents: {},
};

/**
 * Long shots get a smaller automatic limit in proportion to their multiplier:
 * floor(20 × tableMax / multiplier), in whole Points, rounded down to a multiple
 * of 5 from 10 up. With a 50 PTS max: ×24 → 40, ×30 → 30, ×60 → 15, ×170 → 5.
 */
export const AUTO_LIMIT_FACTOR = 20;
const WHOLE_POINT = 100;
const ROUND_TO = 5;

export function autoMarketMaxCents(multiplier: number, limits: TableLimits): number {
  const raw = Math.floor((AUTO_LIMIT_FACTOR * limits.maxCents) / multiplier);
  if (raw >= limits.maxCents) return limits.maxCents;
  const points = Math.floor(raw / WHOLE_POINT);
  const rounded = points >= 10 ? points - (points % ROUND_TO) : points;
  return Math.max(1, rounded) * WHOLE_POINT;
}

export function marketMaxCents(slug: string, limits: TableLimits): number {
  const override = limits.marketMaxCents[slug];
  const max = override && override > 0 ? override : autoMarketMaxCents(getMarket(slug).multiplier, limits);
  return Math.max(limits.minCents, max);
}

export type LimitsError =
  | 'limits_invalid'
  | 'limits_max_below_min'
  | 'limits_cap_below_min'
  | 'limits_market_invalid';

const isCents = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** Validates limits an owner or manager is saving. Returns null when valid. */
export function validateLimits(limits: TableLimits): LimitsError | null {
  const { minCents, maxCents, couponCapCents, maxRounds, marketMaxCents: markets } = limits;
  if (![minCents, maxCents, couponCapCents].every(isCents) || !isCents(maxRounds)) return 'limits_invalid';
  if (maxCents < minCents) return 'limits_max_below_min';
  if (couponCapCents < minCents) return 'limits_cap_below_min';
  for (const [slug, value] of Object.entries(markets)) {
    getMarket(slug);
    if (!isCents(value) || value < minCents) return 'limits_market_invalid';
  }
  return null;
}
