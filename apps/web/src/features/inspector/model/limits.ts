import { autoMarketMaxCents } from '@getflop/engine';

/** Markets & limits editor logic. Pure (tested). */

export interface MarketInfo { slug: string; name: string; group: string; multiplier: number }

export const MARKET_GROUPS = ['popular', 'specials', 'flushes', 'runs', 'pairs'] as const;

export function groupMarkets(markets: readonly MarketInfo[]): { group: string; markets: MarketInfo[] }[] {
  const known = new Set<string>(MARKET_GROUPS);
  const groups = [...MARKET_GROUPS, ...new Set(markets.map((m) => m.group).filter((g) => !known.has(g)))];
  return groups.map((group) => ({ group, markets: markets.filter((m) => m.group === group) })).filter((g) => g.markets.length > 0);
}

/** A table stores [] for "every market". */
export function selectionPayload(selected: ReadonlySet<string>, all: readonly MarketInfo[]): string[] {
  return all.every((m) => selected.has(m.slug)) ? [] : all.filter((m) => selected.has(m.slug)).map((m) => m.slug);
}

/** The table's stored list → the ticked set ([] = all ticked). */
export function initialSelection(stored: readonly string[], all: readonly MarketInfo[]): Set<string> {
  return new Set(stored.length === 0 ? all.map((m) => m.slug) : stored);
}

/** Placeholder of an empty per-market field: the automatic limit for the current min and max. */
export function autoLimitCents(multiplier: number, minCents: number, maxCents: number): number {
  if (!(maxCents > 0) || !(multiplier > 0)) return Math.max(minCents, 0);
  const auto = autoMarketMaxCents(multiplier, { minCents, maxCents, couponCapCents: maxCents, maxRounds: 1, marketMaxCents: {} });
  return Math.max(minCents, auto);
}

export interface LimitsForm { min: string; max: string; cap: string; rounds: string; markets: Record<string, string> }

export interface LimitsPayload {
  minCents: number;
  maxCents: number;
  couponCapCents: number;
  maxRounds: number;
  marketMaxCents: Record<string, number>;
}

export type LimitsError = 'insp_limits_invalid' | 'insp_limits_max_below_min' | 'insp_limits_cap_below_min' | 'insp_limits_market_invalid';

/** "12.5" → 1250; null when not > 0 with at most 2 decimals. */
export function toCents(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return cents > 0 ? cents : null;
}

export const fromCents = (cents: number): string => {
  const v = cents / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

/** Validates the editor. Empty market fields mean "automatic" and are left out. */
export function buildLimits(form: LimitsForm): { ok: true; value: LimitsPayload } | { ok: false; error: LimitsError; slug?: string } {
  const min = toCents(form.min);
  const max = toCents(form.max);
  const cap = toCents(form.cap);
  const rounds = /^\d+$/.test(form.rounds.trim()) ? Number(form.rounds.trim()) : null;
  if (min === null || max === null || cap === null || !rounds) return { ok: false, error: 'insp_limits_invalid' };
  if (max < min) return { ok: false, error: 'insp_limits_max_below_min' };
  if (cap < min) return { ok: false, error: 'insp_limits_cap_below_min' };
  const marketMaxCents: Record<string, number> = {};
  for (const [slug, text] of Object.entries(form.markets)) {
    if (text.trim() === '') continue;
    const cents = toCents(text);
    if (cents === null || cents < min) return { ok: false, error: 'insp_limits_market_invalid', slug };
    marketMaxCents[slug] = cents;
  }
  return { ok: true, value: { minCents: min, maxCents: max, couponCapCents: cap, maxRounds: rounds, marketMaxCents } };
}

export function formFromLimits(l: LimitsPayload): LimitsForm {
  return {
    min: fromCents(l.minCents), max: fromCents(l.maxCents), cap: fromCents(l.couponCapCents), rounds: String(l.maxRounds),
    markets: Object.fromEntries(Object.entries(l.marketMaxCents ?? {}).map(([k, v]) => [k, fromCents(v)])),
  };
}
