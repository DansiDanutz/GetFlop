import { allFlops, MARKETS } from '@getflop/engine';

/** Report math (04 §10): handle, paid, result, hold, theoretical hold and a 95% band. */

export const MIN_PICKS_FOR_HOLD = 30;
const Z95 = 1.96;

export interface BetFact {
  readonly handId: string;
  readonly userId: string;
  readonly market: string;
  readonly stakeCents: number;
  readonly multiplierX100: number;
  readonly payoutCents: number;
  readonly status: string;
}

let probabilities: ReadonlyMap<string, number> | null = null;

/** Exact probability of each market over every possible flop (22,100). Computed once. */
function probabilityMap(): ReadonlyMap<string, number> {
  if (probabilities) return probabilities;
  const flops = allFlops();
  probabilities = new Map(MARKETS.map((m) => [m.slug, flops.filter((f) => m.wins(f)).length / flops.length]));
  return probabilities;
}

export function probabilityOf(slug: string): number {
  return probabilityMap().get(slug) ?? 0;
}

/** 1 − multiplier × probability. */
export function theoreticalHold(slug: string, multiplierX100: number): number {
  return 1 - (multiplierX100 / 100) * probabilityOf(slug);
}

export interface Totals {
  readonly picks: number;
  readonly hands: number;
  readonly players: number;
  readonly handleCents: number;
  readonly paidCents: number;
  readonly resultCents: number;
  readonly holdPct: number | null;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function totals(bets: readonly BetFact[]): Totals {
  const handleCents = bets.reduce((s, b) => s + b.stakeCents, 0);
  const paidCents = bets.reduce((s, b) => s + b.payoutCents, 0);
  return {
    picks: bets.length,
    hands: new Set(bets.map((b) => b.handId)).size,
    players: new Set(bets.map((b) => b.userId)).size,
    handleCents, paidCents, resultCents: handleCents - paidCents, holdPct: ratio(handleCents - paidCents, handleCents),
  };
}

/** Stake-weighted theoretical hold of a set of picks. */
export function weightedTheoHold(bets: readonly BetFact[]): number | null {
  const handle = bets.reduce((s, b) => s + b.stakeCents, 0);
  const theo = bets.reduce((s, b) => s + b.stakeCents * theoreticalHold(b.market, b.multiplierX100), 0);
  return ratio(theo, handle);
}

export type HoldVerdict = 'low_volume' | 'inside' | 'above' | 'below';

export interface MarketStat {
  readonly slug: string;
  readonly picks: number;
  readonly hits: number;
  readonly expectedHits: number;
  readonly handleCents: number;
  readonly paidCents: number;
  readonly resultCents: number;
  readonly holdPct: number | null;
  readonly theoHoldPct: number;
  readonly lowPct: number;
  readonly highPct: number;
  readonly verdict: HoldVerdict;
}

function verdictOf(picks: number, hold: number | null, low: number, high: number): HoldVerdict {
  if (picks < MIN_PICKS_FOR_HOLD || hold === null) return 'low_volume';
  if (hold > high) return 'above';
  if (hold < low) return 'below';
  return 'inside';
}

function statFor(slug: string, bets: readonly BetFact[]): MarketStat {
  const p = probabilityOf(slug);
  const t = totals(bets);
  const theo = weightedTheoHold(bets) ?? 0;
  // Variance of the club result: each pick pays stake × m with probability p.
  const variance = bets.reduce((s, b) => s + (b.stakeCents * b.multiplierX100 / 100) ** 2 * p * (1 - p), 0);
  const spread = t.handleCents === 0 ? 0 : (Z95 * Math.sqrt(variance)) / t.handleCents;
  return {
    slug, picks: t.picks, hits: bets.filter((b) => b.status === 'won').length, expectedHits: bets.length * p,
    handleCents: t.handleCents, paidCents: t.paidCents, resultCents: t.resultCents, holdPct: t.holdPct,
    theoHoldPct: theo, lowPct: theo - spread, highPct: theo + spread,
    verdict: verdictOf(t.picks, t.holdPct, theo - spread, theo + spread),
  };
}

export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  // Builds a fresh map; the input is never touched.
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Per market, in catalogue order. */
export function marketStats(bets: readonly BetFact[]): MarketStat[] {
  const bySlug = groupBy(bets, (b) => b.market);
  const order = MARKETS.map((m) => m.slug);
  return [...bySlug.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([slug, list]) => statFor(slug, list));
}
