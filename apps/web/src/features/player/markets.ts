import type { BlockReason } from './slip';
import type { HandStatus, HeatBoard, OfferedMarket } from './types';

/** Market presentation: picker tabs, rules groups, example flops (spec 01 §2.2–2.3). */

export type FilterTab = 'popular' | 'pairs' | 'flushes' | 'colors' | 'straights' | 'specials' | 'all';
export const FILTER_TABS: readonly FilterTab[] = ['popular', 'pairs', 'flushes', 'colors', 'straights', 'specials', 'all'];

const PAIR_RANKS = [
  ['aces', 'A'], ['kings', 'K'], ['queens', 'Q'], ['jacks', 'J'], ['tens', 'T'], ['nines', '9'], ['eights', '8'],
  ['sevens', '7'], ['sixes', '6'], ['fives', '5'], ['fours', '4'], ['threes', '3'], ['twos', '2'],
] as const;
const PAIR_SLUGS = PAIR_RANKS.map(([key]) => `pair-${key}`);
const SUIT_FLUSHES = ['flush-hearts', 'flush-diamonds', 'flush-clubs', 'flush-spades'];

/** Display order used to break ties between equal multipliers (the price-table order). */
const DISPLAY_ORDER: readonly string[] = [
  'rainbow', 'same-color', 'has-ace', 'any-pair', 'any-flush', 'all-lows', 'straight', 'all-faces',
  ...PAIR_SLUGS, ...SUIT_FLUSHES, 'trips-or-sf', 'any-trips', 'straight-flush',
];

const POPULAR = new Set(['rainbow', 'same-color', 'any-pair', 'any-flush', 'straight', 'has-ace', 'all-faces', 'trips-or-sf', 'pair-aces', 'all-lows']);

/** Filter category of each market (the catalogue's `category`). */
export type Category = 'pair' | 'flush' | 'color' | 'straight' | 'special';

export function categoryOf(slug: string): Category {
  if (slug === 'any-pair' || slug.startsWith('pair-')) return 'pair';
  if (slug === 'any-flush' || slug.startsWith('flush-')) return 'flush';
  if (slug === 'rainbow' || slug === 'same-color') return 'color';
  if (slug === 'straight' || slug === 'straight-flush') return 'straight';
  return 'special';
}

const TAB_CATEGORY: Partial<Record<FilterTab, Category>> = {
  pairs: 'pair', flushes: 'flush', colors: 'color', straights: 'straight', specials: 'special',
};

const orderIndex = (slug: string) => {
  const i = DISPLAY_ORDER.indexOf(slug);
  return i === -1 ? DISPLAY_ORDER.length : i;
};

/** Markets in a picker tab, cheapest multiplier first. */
export function marketsForTab(offered: readonly OfferedMarket[], tab: FilterTab): OfferedMarket[] {
  const category = TAB_CATEGORY[tab];
  const inTab = offered.filter((m) => (tab === 'all' ? true : tab === 'popular' ? POPULAR.has(m.slug) : categoryOf(m.slug) === category));
  return [...inTab].sort((a, b) => a.multiplier - b.multiplier || orderIndex(a.slug) - orderIndex(b.slug));
}

export interface RuleGroup {
  readonly key: 'main' | 'specials' | 'flushes' | 'runs' | 'pairs';
  readonly slugs: readonly string[];
}

/** Rules screen groups. Markets the catalogue has switched off are hidden by the screen. */
export const RULE_GROUPS: readonly RuleGroup[] = [
  { key: 'main', slugs: ['rainbow', 'same-color', 'has-ace', 'any-pair'] },
  { key: 'specials', slugs: ['all-faces', 'all-lows', 'trips-or-sf', 'any-trips'] },
  { key: 'flushes', slugs: ['any-flush', ...SUIT_FLUSHES] },
  { key: 'runs', slugs: ['straight', 'straight-flush'] },
  { key: 'pairs', slugs: PAIR_SLUGS },
];

const PAIR_EXAMPLES: Record<string, string[][]> = Object.fromEntries(
  PAIR_RANKS.map(([key, rank]) => [`pair-${key}`, [[`${rank}h`, `${rank}s`, rank === '4' ? '9d' : '4d']]]),
);

/** Example flops for the rules screen (each wins its market). */
export const EXAMPLE_FLOPS: Readonly<Record<string, string[][]>> = {
  rainbow: [['Ah', '7s', 'Kd']],
  'same-color': [['2h', '7d', 'Kh']],
  'has-ace': [['Ah', '8d', '3s']],
  'any-pair': [['7h', '7s', 'Kd']],
  'any-flush': [['2h', '7h', 'Kh']],
  'flush-hearts': [['2h', '7h', 'Kh']],
  'flush-diamonds': [['3d', '8d', 'Qd']],
  'flush-clubs': [['4c', '9c', 'Jc']],
  'flush-spades': [['5s', 'Ts', 'As']],
  straight: [['5h', '6d', '7s']],
  'straight-flush': [['5h', '6h', '7h']],
  'all-faces': [['Ah', 'Kd', 'Js']],
  'all-lows': [['2h', '4d', '6s']],
  'any-trips': [['9h', '9s', '9d']],
  'trips-or-sf': [['9h', '9s', '9d'], ['5h', '6h', '7h']],
  ...PAIR_EXAMPLES,
};

/** Why a member cannot play at this table, or null when they can. */
export function blockReason(input: {
  canPlay: boolean; dealerId: string | null; userId: string | undefined; playMode: 'play' | 'watch' | undefined;
}): BlockReason | null {
  if (input.canPlay) return null;
  if (input.userId && input.dealerId === input.userId) return 'dealer';
  if (input.playMode === 'watch') return 'watch';
  return 'staff';
}

export type TablePhase = 'open' | 'closed' | 'settled' | 'cancelled' | 'waiting' | 'table_closed';

/** Stage state: the live hand, else the last hand's outcome (a newer cancelled hand wins). */
export function tablePhase(
  table: { status: string; currentHand: { status: HandStatus } | null; lastHand: { status: HandStatus } | null },
  latestCancelled = false,
): TablePhase {
  if (table.status !== 'open') return 'table_closed';
  if (table.currentHand?.status === 'betting_open') return 'open';
  if (table.currentHand?.status === 'betting_closed') return 'closed';
  if (latestCancelled) return 'cancelled';
  if (table.lastHand) return 'settled';
  return 'waiting';
}

/** Minimum flops before the board says anything. */
export const HEAT_MIN_FLOPS = 10;

export interface HeatHeadline {
  readonly state: 'few' | 'filling' | 'calm' | 'mixed';
  readonly hot: readonly string[];
  readonly cold: readonly string[];
}

export function heatHeadline(board: HeatBoard): HeatHeadline {
  if (board.flopsCounted < HEAT_MIN_FLOPS) return { state: 'few', hot: [], cold: [] };
  if (board.flopsCounted < board.window) return { state: 'filling', hot: [], cold: [] };
  if (board.hot.length === 0 && board.cold.length === 0) return { state: 'calm', hot: [], cold: [] };
  return { state: 'mixed', hot: board.hot, cold: board.cold };
}

/** Translation key of a market's display name. */
export const marketKey = (slug: string): string => `player_market_${slug.replace(/-/g, '_')}`;
