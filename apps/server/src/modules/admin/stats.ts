import { allFlops, MARKETS } from '@getflop/engine';

/** z for a two-sided 95% interval. */
export const WILSON_Z = 1.96;
/** Below this many settled picks a market is "too few to judge". */
export const MIN_PICKS_TO_JUDGE = 50;

let probabilities: ReadonlyMap<string, number> | undefined;

/** Exact chance of every market over all 22,100 flops (computed once). */
function probabilityTable(): ReadonlyMap<string, number> {
  if (probabilities) return probabilities;
  const flops = allFlops();
  probabilities = new Map(MARKETS.map((m) => [m.slug, flops.filter((f) => m.wins(f)).length / flops.length]));
  return probabilities;
}

export function marketProbability(slug: string): number {
  return probabilityTable().get(slug) ?? 0;
}

/** Fair price as X:1 (the multiplier minus one). */
export function fairOdds(probability: number): number {
  return probability > 0 ? 1 / probability - 1 : 0;
}

/** House edge `1 − (odds + 1) × chance`. Negative: the club loses on every Point played. */
export function edgeOf(payoutOdds: number, probability: number): number {
  return 1 - (payoutOdds + 1) * probability;
}

/** X:1 odds → multiplier stored ×100 (1.3 → 230). */
export function oddsToMultiplierX100(payoutOdds: number): number {
  return Math.max(101, Math.round((payoutOdds + 1) * 100));
}

export interface Interval { readonly low: number; readonly high: number }

/** Wilson score interval for `hits` out of `n`. */
export function wilsonInterval(hits: number, n: number, z = WILSON_Z): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export type Verdict = 'too_few' | 'more' | 'less' | 'as_priced';

/** Compares the observed hit rate with the priced probability. */
export function marketVerdict(hits: number, n: number, pricedProbability: number): Verdict {
  if (n < MIN_PICKS_TO_JUDGE) return 'too_few';
  const { low, high } = wilsonInterval(hits, n);
  if (pricedProbability < low) return 'more';
  if (pricedProbability > high) return 'less';
  return 'as_priced';
}
