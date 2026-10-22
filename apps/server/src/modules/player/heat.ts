import { allFlops, getMarket, parseFlop, type Flop } from '@getflop/engine';
import { and, desc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { hands } from '../../db/schema/index.js';
import type { TableRow } from '../game/tables.js';

/**
 * Heat board ("Hot & cold", spec 01 §8). Statistics over the last `window`
 * settled flops of a table. It is not a prediction: every flop is independent.
 *
 * Tolerance band (the dashed band on the bars). For a market with probability
 * p over n counted flops, the hit count is Binomial(n, p):
 *
 *   expected hits  μ = n·p
 *   std deviation  σ = √(n·p·(1 − p))
 *   band (hits)    [max(0, μ − 2σ), μ + 2σ]      (≈95% of windows land inside)
 *
 * The API reports the band as rates (hits / n). A market is only judged once the
 * window is full (n = window). Then it is `hot` when hits > μ + 2σ and `cold`
 * when hits < μ − 2σ; otherwise it is running normally. Rare markets whose
 * lower bound is 0 can be hot but never cold.
 */
export const HEAT_WINDOW = 50;
export const BAND_SIGMAS = 2;

/** Markets on the board, in display order (Rainbow, Colour, Ace, Pair, Flush, Low, Run, Jack+, Trips, Str flush). */
export const HEAT_MARKETS = [
  'rainbow', 'same-color', 'has-ace', 'any-pair', 'any-flush', 'all-lows', 'straight', 'all-faces', 'any-trips', 'straight-flush',
] as const;

export type HeatState = 'hot' | 'cold' | 'normal';

export interface HeatMarket {
  readonly slug: string;
  readonly name: string;
  readonly hits: number;
  /** hits / flopsCounted (0 when nothing counted). */
  readonly rate: number;
  /** Probability of the market on one flop. */
  readonly expected: number;
  /** Tolerance band as rates. */
  readonly band: { readonly low: number; readonly high: number };
  /** Whether the window is full so a verdict can be given. */
  readonly judged: boolean;
  readonly state: HeatState;
  /** One entry per counted flop, oldest first. */
  readonly hitSeq: readonly boolean[];
}

export interface HeatBoard {
  readonly window: number;
  readonly flopsCounted: number;
  readonly markets: readonly HeatMarket[];
  /** Hot slugs, furthest above the band first. */
  readonly hot: readonly string[];
  /** Cold slugs, furthest below the band first. */
  readonly cold: readonly string[];
}

const probabilityCache = new Map<string, number>();

/** Exact probability of a market over all 22,100 flops (memoized per market). */
export function marketProbability(slug: string): number {
  const cached = probabilityCache.get(slug);
  if (cached !== undefined) return cached;
  const market = getMarket(slug);
  const flops = allFlops();
  const probability = flops.filter((f) => market.wins(f)).length / flops.length;
  probabilityCache.set(slug, probability);
  return probability;
}

/** The ±2σ binomial band as rates, clamped to [0, 1]. */
export function bandFor(p: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: p, high: p };
  const mu = n * p;
  const sigma = Math.sqrt(n * p * (1 - p));
  return {
    low: Math.max(0, mu - BAND_SIGMAS * sigma) / n,
    high: Math.min(n, mu + BAND_SIGMAS * sigma) / n,
  };
}

function zScore(hits: number, p: number, n: number): number {
  const sigma = Math.sqrt(n * p * (1 - p));
  return sigma === 0 ? 0 : (hits - n * p) / sigma;
}

/** Builds the board from flops ordered oldest first. Only the last `window` flops count. */
export function computeHeat(flops: readonly Flop[], window: number = HEAT_WINDOW): HeatBoard {
  const counted = flops.slice(Math.max(0, flops.length - window));
  const n = counted.length;
  const judged = n >= window;
  const markets = HEAT_MARKETS.map((slug): HeatMarket => {
    const market = getMarket(slug);
    const hitSeq = counted.map((f) => market.wins(f));
    const hits = hitSeq.filter(Boolean).length;
    const expected = marketProbability(slug);
    const band = bandFor(expected, n);
    const rate = n === 0 ? 0 : hits / n;
    const state: HeatState = !judged ? 'normal' : rate > band.high ? 'hot' : rate < band.low ? 'cold' : 'normal';
    return { slug, name: market.name, hits, rate, expected, band, judged, state, hitSeq };
  });
  const byZ = (dir: 1 | -1) => (a: HeatMarket, b: HeatMarket) =>
    dir * (zScore(b.hits, b.expected, n) - zScore(a.hits, a.expected, n));
  return {
    window,
    flopsCounted: n,
    markets,
    hot: markets.filter((m) => m.state === 'hot').sort(byZ(1)).map((m) => m.slug),
    cold: markets.filter((m) => m.state === 'cold').sort(byZ(-1)).map((m) => m.slug),
  };
}

/**
 * Loads the last `window` settled flops of a table, oldest first. A tournament
 * table counts only the hands of its current tournament.
 */
export async function tableHeat(db: DbOrTx, table: TableRow, window: number = HEAT_WINDOW): Promise<HeatBoard> {
  const conditions = [eq(hands.tableId, table.id), eq(hands.status, 'settled')];
  if (table.tournamentId) conditions.push(eq(hands.tournamentId, table.tournamentId));
  const rows = await db.select({ card1: hands.card1, card2: hands.card2, card3: hands.card3 }).from(hands)
    .where(and(...conditions)).orderBy(desc(hands.handNumber)).limit(window);
  const flops = rows
    .filter((r) => r.card1 && r.card2 && r.card3)
    .map((r) => parseFlop([r.card1!, r.card2!, r.card3!]))
    .reverse();
  return computeHeat(flops, window);
}
