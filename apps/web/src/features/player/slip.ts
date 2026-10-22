import { MARKETS, marketMaxCents, payoutCents } from '@getflop/engine';
import type { OfferedMarket, TableLimits, Unit } from './types';

/** Coupon slip math (spec 01 §2.5, §3.1, §5; 06 §4.4). All amounts are integer cents. */

export interface SlipPick {
  readonly market: string;
  readonly stakeCents: number;
}

const KNOWN = new Set(MARKETS.map((m) => m.slug));
const QUICK_POINTS = [1, 2, 5, 10, 20, 50] as const;
const CENTS_PER_POINT = 100;
/** Estimated table pace: about 2.2 minutes per flop. */
export const MINUTES_PER_FLOP = 2.2;
/** Default number of flops on a fresh slip. */
export const DEFAULT_ROUNDS = 1;

const toEngineLimits = (l: TableLimits) => ({ ...l, marketMaxCents: l.marketMaxCents ?? {} });

/** Effective maximum per pick, per flop, on one market (automatic long-shot limit or override). */
export function marketMax(slug: string, limits: TableLimits): number {
  if (!KNOWN.has(slug)) return limits.maxCents;
  return marketMaxCents(slug, toEngineLimits(limits));
}

export function clampStake(stakeCents: number, slug: string, limits: TableLimits): number {
  return Math.min(Math.max(Math.round(stakeCents), limits.minCents), marketMax(slug, limits));
}

export function clampRounds(rounds: number, maxRounds: number): number {
  return Math.min(Math.max(Math.round(rounds), 1), Math.max(1, maxRounds));
}

/** Quick amount chips that fit the table limits. */
export function quickAmounts(limits: TableLimits): number[] {
  return QUICK_POINTS.map((p) => p * CENTS_PER_POINT).filter((c) => c >= limits.minCents && c <= limits.maxCents);
}

/** Adds a market at the shared amount (clamped to that market), or removes it when already picked. */
export function togglePick(picks: readonly SlipPick[], slug: string, sharedCents: number, limits: TableLimits): SlipPick[] {
  if (picks.some((p) => p.market === slug)) return picks.filter((p) => p.market !== slug);
  return [...picks, { market: slug, stakeCents: clampStake(sharedCents, slug, limits) }];
}

/** Applies a new shared amount to every pick, each clamped to its own market. */
export function setSharedAmount(picks: readonly SlipPick[], sharedCents: number, limits: TableLimits): SlipPick[] {
  return picks.map((p) => ({ market: p.market, stakeCents: clampStake(sharedCents, p.market, limits) }));
}

export function setPickStake(picks: readonly SlipPick[], slug: string, stakeCents: number, limits: TableLimits): SlipPick[] {
  return picks.map((p) => (p.market === slug ? { market: p.market, stakeCents: clampStake(stakeCents, slug, limits) } : p));
}

export function perFlopCents(picks: readonly SlipPick[]): number {
  return picks.reduce((sum, p) => sum + p.stakeCents, 0);
}

/** Total commitment = Σ stake × rounds (debited at placement). */
export function commitmentCents(picks: readonly SlipPick[], rounds: number): number {
  return perFlopCents(picks) * rounds;
}

/** Upper bound: every pick wins on every flop. Payout = stake + floor(stake × odds). */
export function topWinCents(picks: readonly SlipPick[], rounds: number, offered: readonly OfferedMarket[]): number {
  const multiplierOf = (slug: string) => offered.find((m) => m.slug === slug)?.multiplier ?? 0;
  return picks.reduce((sum, p) => sum + payoutCents(p.stakeCents, multiplierOf(p.market)), 0) * rounds;
}

export function estimatedMinutes(rounds: number): number {
  return Math.max(1, Math.round(rounds * MINUTES_PER_FLOP));
}

export type BlockReason = 'staff' | 'watch' | 'dealer';

export type SlipIssue =
  | { kind: 'server'; code: string }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'amount'; market: string; min: number; max: number }
  | { kind: 'cap'; max: number }
  | { kind: 'balance' };

export interface SlipState {
  readonly picks: readonly SlipPick[];
  readonly rounds: number;
  readonly limits: TableLimits;
  readonly unit: Unit;
  readonly balanceCents: number;
  readonly blockedBy: BlockReason | null;
  /** Error code of the last failed placement, cleared when the slip changes. */
  readonly serverError: string | null;
}

/** The first problem with the slip, in the order the player is told about them. */
export function slipIssue(s: SlipState): SlipIssue | null {
  if (s.serverError) return { kind: 'server', code: s.serverError };
  if (s.blockedBy) return { kind: 'blocked', reason: s.blockedBy };
  const bad = s.picks.find((p) => p.stakeCents < s.limits.minCents || p.stakeCents > marketMax(p.market, s.limits));
  if (bad) return { kind: 'amount', market: bad.market, min: s.limits.minCents, max: marketMax(bad.market, s.limits) };
  const total = commitmentCents(s.picks, s.rounds);
  if (s.unit === 'points' && total > s.limits.couponCapCents) return { kind: 'cap', max: s.limits.couponCapCents };
  if (total > s.balanceCents) return { kind: 'balance' };
  return null;
}

export interface PlayAgainResult {
  readonly picks: SlipPick[];
  readonly rounds: number;
  /** Markets dropped because the table does not offer them. */
  readonly dropped: number;
  /** Amounts changed to fit the table limits. */
  readonly adjusted: number;
  readonly roundsClamped: boolean;
  /** Nothing fits this table. */
  readonly empty: boolean;
}

/** Loads a finished coupon's picks onto this table's slip (spec 01 §5.6). */
export function playAgain(
  picks: readonly SlipPick[],
  rounds: number,
  table: { readonly limits: TableLimits; readonly offered: readonly OfferedMarket[] },
): PlayAgainResult {
  const offered = new Set(table.offered.map((m) => m.slug));
  const kept = picks.filter((p) => offered.has(p.market));
  const clamped = kept.map((p) => ({ market: p.market, stakeCents: clampStake(p.stakeCents, p.market, table.limits) }));
  const nextRounds = clampRounds(rounds, table.limits.maxRounds);
  return {
    picks: clamped,
    rounds: nextRounds,
    dropped: picks.length - kept.length,
    adjusted: clamped.filter((p, i) => p.stakeCents !== kept[i]!.stakeCents).length,
    roundsClamped: nextRounds !== rounds,
    empty: clamped.length === 0,
  };
}
