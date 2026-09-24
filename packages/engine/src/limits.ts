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
 * Long shots get a smaller automatic limit in proportion to their multiplier
 * (tour: 5 PTS on ×170 with a 50 PTS table max). Factor inferred from that point.
 */
export const AUTO_LIMIT_FACTOR = 17;
const WHOLE_POINT = 100;

export function autoMarketMaxCents(multiplier: number, limits: TableLimits): number {
  const proportional = Math.floor((limits.maxCents * AUTO_LIMIT_FACTOR) / multiplier / WHOLE_POINT) * WHOLE_POINT;
  return Math.max(limits.minCents, Math.min(limits.maxCents, proportional));
}

export function marketMaxCents(slug: string, limits: TableLimits): number {
  return limits.marketMaxCents[slug] ?? autoMarketMaxCents(getMarket(slug).multiplier, limits);
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
