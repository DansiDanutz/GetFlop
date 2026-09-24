import { RED_SUITS, type Flop, type Rank, type Suit } from './cards.js';

export type MarketGroup = 'popular' | 'specials' | 'flushes' | 'runs' | 'pairs';

export interface MarketDef {
  readonly slug: string;
  readonly name: string;
  readonly group: MarketGroup;
  /** Total return per unit staked on a win (stake included), e.g. 2.3. */
  readonly multiplier: number;
  /** Whether a new table offers this market by default. */
  readonly enabledByDefault: boolean;
  readonly wins: (flop: Flop) => boolean;
}

const ranksOf = (flop: Flop): number[] => flop.map((c) => c.rank).sort((a, b) => a - b);

function rankCounts(flop: Flop): Map<number, number> {
  const counts = new Map<number, number>();
  for (const c of flop) counts.set(c.rank, (counts.get(c.rank) ?? 0) + 1);
  return counts;
}

/** Exactly two cards share a rank (trips is NOT a pair). */
function pairRank(flop: Flop): number | null {
  for (const [rank, n] of rankCounts(flop)) if (n === 2) return rank;
  return null;
}

const isTrips = (flop: Flop): boolean => flop[0].rank === flop[1].rank && flop[1].rank === flop[2].rank;
const isFlush = (flop: Flop): boolean => flop[0].suit === flop[1].suit && flop[1].suit === flop[2].suit;

/** Three consecutive ranks in any order. Ace plays high (Q-K-A) or low (A-2-3); no wrap (K-A-2). */
export function isStraight(flop: Flop): boolean {
  const [a, b, c] = ranksOf(flop) as [number, number, number];
  if (b === a + 1 && c === b + 1) return true;
  return a === 2 && b === 3 && c === 14;
}

const isStraightFlush = (flop: Flop): boolean => isFlush(flop) && isStraight(flop);

const PAIR_NAMES: ReadonlyArray<readonly [Rank, string, string]> = [
  [14, 'aces', 'Aces'], [13, 'kings', 'Kings'], [12, 'queens', 'Queens'], [11, 'jacks', 'Jacks'],
  [10, 'tens', 'Tens'], [9, 'nines', 'Nines'], [8, 'eights', 'Eights'], [7, 'sevens', 'Sevens'],
  [6, 'sixes', 'Sixes'], [5, 'fives', 'Fives'], [4, 'fours', 'Fours'], [3, 'threes', 'Threes'],
  [2, 'twos', 'Twos'],
];

const SUIT_NAMES: ReadonlyArray<readonly [Suit, string, string]> = [
  ['h', 'hearts', 'Hearts'], ['d', 'diamonds', 'Diamonds'], ['c', 'clubs', 'Clubs'], ['s', 'spades', 'Spades'],
];

/**
 * Market catalogue. Multipliers for markets shown on the public tour are exact;
 * `any-trips` and `straight-flush` are not on the tour and use inferred prices
 * (≈23% margin) and are off by default.
 */
export const MARKETS: readonly MarketDef[] = [
  { slug: 'rainbow', name: 'Rainbow', group: 'popular', multiplier: 2.3, enabledByDefault: true,
    wins: (f) => new Set(f.map((c) => c.suit)).size === 3 },
  { slug: 'same-color', name: 'All Same Color', group: 'popular', multiplier: 3.8, enabledByDefault: true,
    wins: (f) => new Set(f.map((c) => RED_SUITS.has(c.suit))).size === 1 },
  { slug: 'has-ace', name: 'Contains an Ace', group: 'popular', multiplier: 4, enabledByDefault: true,
    wins: (f) => f.some((c) => c.rank === 14) },
  { slug: 'any-pair', name: 'Any Pair', group: 'popular', multiplier: 5, enabledByDefault: true,
    wins: (f) => pairRank(f) !== null },
  { slug: 'all-lows', name: 'All Low Cards (2-6)', group: 'specials', multiplier: 16, enabledByDefault: true,
    wins: (f) => f.every((c) => c.rank <= 6) },
  { slug: 'all-faces', name: 'Jack or Better', group: 'specials', multiplier: 30, enabledByDefault: true,
    wins: (f) => f.every((c) => c.rank >= 11) },
  { slug: 'trips-or-sf', name: 'Trips or Straight Flush', group: 'specials', multiplier: 170, enabledByDefault: true,
    wins: (f) => isTrips(f) || isStraightFlush(f) },
  { slug: 'any-trips', name: 'Trips', group: 'specials', multiplier: 330, enabledByDefault: false, wins: isTrips },
  { slug: 'any-flush', name: 'Flush (Any Suit)', group: 'flushes', multiplier: 16, enabledByDefault: true, wins: isFlush },
  ...SUIT_NAMES.map(([suit, key, label]): MarketDef => ({
    slug: `flush-${key}`, name: `All ${label}`, group: 'flushes', multiplier: 60, enabledByDefault: true,
    wins: (f) => f.every((c) => c.suit === suit),
  })),
  { slug: 'straight', name: 'Three Consecutive', group: 'runs', multiplier: 24, enabledByDefault: true, wins: isStraight },
  { slug: 'straight-flush', name: 'Straight Flush', group: 'runs', multiplier: 350, enabledByDefault: false,
    wins: isStraightFlush },
  ...PAIR_NAMES.map(([rank, key, label]): MarketDef => ({
    slug: `pair-${key}`, name: `Pair of ${label}`, group: 'pairs', multiplier: 60, enabledByDefault: true,
    wins: (f) => pairRank(f) === rank,
  })),
];

const BY_SLUG = new Map(MARKETS.map((m) => [m.slug, m]));

export function getMarket(slug: string): MarketDef {
  const market = BY_SLUG.get(slug);
  if (!market) throw new Error(`Unknown market: ${slug}`);
  return market;
}

/** Slugs of every market the flop wins. */
export function winningMarkets(flop: Flop): string[] {
  return MARKETS.filter((m) => m.wins(flop)).map((m) => m.slug);
}
