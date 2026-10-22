import { addDays } from './time.js';

/** Badge codes in display order, grouped as the UI shows them. */
export const BADGE_GROUPS = {
  flops: ['first_flop', 'flops_10', 'flops_100', 'flops_1000'],
  big: ['hit_x170', 'hit_x40', 'three_in_a_row'],
  exploring: ['every_market', 'ten_markets_won'],
  comeback: ['comeback', 'week_streak'],
  week: ['week_top10', 'week_top3', 'week_first'],
} as const;

export type BadgeGroup = keyof typeof BADGE_GROUPS;
export type BadgeCode = (typeof BADGE_GROUPS)[BadgeGroup][number];
export const WEEKLY_BADGES: readonly BadgeCode[] = BADGE_GROUPS.week;

const FLOP_TARGETS: Readonly<Record<string, number>> = { first_flop: 1, flops_10: 10, flops_100: 100, flops_1000: 1_000 };
const X170 = 17_000;
const X40 = 4_000;
const ROW_TARGET = 3;
const DAYS_TARGET = 7;
const MARKETS_WON_TARGET = 10;

/** Per-player progress stored in arena_players. */
export interface Progress {
  readonly totalFlops: number;
  readonly flopsWon: number;
  readonly winStreak: number;
  readonly bestWinStreak: number;
  readonly lastPlayDay: string | null;
  readonly dayStreak: number;
  readonly bestDayStreak: number;
  readonly marketsPlayed: readonly string[];
  readonly marketsWon: readonly string[];
  readonly bestHitX100: number;
  readonly lowWeek: string | null;
}

export const EMPTY_PROGRESS: Progress = {
  totalFlops: 0, flopsWon: 0, winStreak: 0, bestWinStreak: 0, lastPlayDay: null, dayStreak: 0, bestDayStreak: 0,
  marketsPlayed: [], marketsWon: [], bestHitX100: 0, lowWeek: null,
};

/** What one player did on one settled flop. */
export interface FlopSummary {
  readonly stakeCents: number;
  readonly paidCents: number;
  readonly picks: number;
  readonly picksWon: number;
  readonly markets: readonly string[];
  readonly marketsWon: readonly string[];
  /** Highest multiplier ×100 among this flop's winning picks (0 if none). */
  readonly bestWinX100: number;
}

export interface FlopContext {
  readonly day: string;
  readonly week: string;
  /** Wallet balance after the flop was paid. */
  readonly balanceCents: number;
  readonly comebackFloorCents: number;
  readonly comebackPeakCents: number;
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();

function nextDayStreak(p: Progress, day: string): number {
  if (p.lastPlayDay === day) return Math.max(1, p.dayStreak);
  return p.lastPlayDay === addDays(day, -1) ? p.dayStreak + 1 : 1;
}

/** New progress after one flop, plus whether this flop completed a comeback. */
export function advanceProgress(p: Progress, flop: FlopSummary, ctx: FlopContext): Progress & { readonly comeback: boolean } {
  const won = flop.picksWon > 0;
  const winStreak = won ? p.winStreak + 1 : 0;
  const dayStreak = nextDayStreak(p, ctx.day);
  const lowWeek = ctx.balanceCents < ctx.comebackFloorCents ? ctx.week : p.lowWeek;
  return {
    totalFlops: p.totalFlops + 1,
    flopsWon: p.flopsWon + (won ? 1 : 0),
    winStreak,
    bestWinStreak: Math.max(p.bestWinStreak, winStreak),
    lastPlayDay: ctx.day,
    dayStreak,
    bestDayStreak: Math.max(p.bestDayStreak, dayStreak),
    marketsPlayed: union(p.marketsPlayed, flop.markets),
    marketsWon: union(p.marketsWon, flop.marketsWon),
    bestHitX100: Math.max(p.bestHitX100, flop.bestWinX100),
    lowWeek,
    comeback: lowWeek === ctx.week && ctx.balanceCents > ctx.comebackPeakCents,
  };
}

/** Every non-weekly badge the progress qualifies for (already-earned ones included). */
export function earnedBadges(p: Progress, opts: { offered: readonly string[]; comeback: boolean }): BadgeCode[] {
  const played = new Set(p.marketsPlayed);
  const checks: [BadgeCode, boolean][] = [
    ...Object.entries(FLOP_TARGETS).map(([code, n]): [BadgeCode, boolean] => [code as BadgeCode, p.totalFlops >= n]),
    ['hit_x170', p.bestHitX100 >= X170],
    ['hit_x40', p.bestHitX100 >= X40],
    ['three_in_a_row', p.bestWinStreak >= ROW_TARGET],
    ['every_market', opts.offered.length > 0 && opts.offered.every((m) => played.has(m))],
    ['week_streak', p.bestDayStreak >= DAYS_TARGET],
    ['comeback', opts.comeback],
    ['ten_markets_won', p.marketsWon.length >= MARKETS_WON_TARGET],
  ];
  return checks.filter(([, ok]) => ok).map(([code]) => code);
}

export interface BadgeProgress {
  readonly current: number;
  readonly target: number;
  readonly best?: number;
}

/** "Next badge" progress: n more flops / in a row / days / markets / weeks, with "your best". */
export function badgeProgress(
  code: BadgeCode, p: Progress, offeredCount: number, weeklyTimes: Partial<Record<string, number>>,
): BadgeProgress | null {
  if (code in FLOP_TARGETS) return { current: p.totalFlops, target: FLOP_TARGETS[code]! };
  switch (code) {
    case 'hit_x170': return { current: Math.floor(p.bestHitX100 / 100), target: X170 / 100, best: Math.floor(p.bestHitX100 / 100) };
    case 'hit_x40': return { current: Math.floor(p.bestHitX100 / 100), target: X40 / 100, best: Math.floor(p.bestHitX100 / 100) };
    case 'three_in_a_row': return { current: p.winStreak, target: ROW_TARGET, best: p.bestWinStreak };
    case 'week_streak': return { current: p.dayStreak, target: DAYS_TARGET, best: p.bestDayStreak };
    case 'every_market': return { current: Math.min(p.marketsPlayed.length, offeredCount), target: offeredCount };
    case 'ten_markets_won': return { current: p.marketsWon.length, target: MARKETS_WON_TARGET };
    case 'week_top10': case 'week_top3': case 'week_first': return { current: weeklyTimes[code] ?? 0, target: 1 };
    default: return null;
  }
}

export const groupOf = (code: BadgeCode): BadgeGroup =>
  (Object.keys(BADGE_GROUPS) as BadgeGroup[]).find((g) => (BADGE_GROUPS[g] as readonly string[]).includes(code))!;

export const ALL_BADGES: readonly BadgeCode[] = Object.values(BADGE_GROUPS).flat();
