/** Pure helpers for the Tournament TV: level progression and leaderboard order. */

export interface TvLevel {
  readonly levelNumber: number;
  readonly minBetChips: number;
  /** −1 = no maximum. */
  readonly maxBetChips: number;
  readonly endHand: number;
}

export interface LevelWindow extends TvLevel {
  readonly startHand: number;
}

export interface LevelProgress {
  readonly current: LevelWindow | null;
  readonly next: LevelWindow | null;
  readonly isFinal: boolean;
}

function windows(levels: readonly TvLevel[]): LevelWindow[] {
  const sorted = [...levels].sort((a, b) => a.endHand - b.endHand);
  return sorted.map((l, i) => ({ ...l, startHand: i === 0 ? 1 : sorted[i - 1]!.endHand + 1 }));
}

/** The level in force for a hand number (0 = not started yet), the next one, and whether it is the last. */
export function levelProgress(levels: readonly TvLevel[], handNumber: number): LevelProgress {
  const list = windows(levels);
  if (list.length === 0) return { current: null, next: null, isFinal: false };
  const hand = Math.max(1, handNumber);
  const index = list.findIndex((l) => hand <= l.endHand);
  const at = index === -1 ? list.length - 1 : index;
  return { current: list[at]!, next: list[at + 1] ?? null, isFinal: at === list.length - 1 };
}

export type EntryStatus = 'playing' | 'finished';

export interface TvEntry {
  readonly name: string;
  readonly chips: number;
  readonly status: EntryStatus;
  /** Final place once finished (busted or tournament over). */
  readonly place: number | null;
  readonly payoutCents: number;
}

export interface RankedEntry extends TvEntry {
  readonly rank: number;
}

/** Playing players by chips (desc), then finished players by place. Ranks follow that order unless a place is known. */
export function rankLeaderboard(entries: readonly TvEntry[]): RankedEntry[] {
  const playing = entries.filter((e) => e.status === 'playing').sort((a, b) => b.chips - a.chips || a.name.localeCompare(b.name));
  const finished = entries.filter((e) => e.status !== 'playing')
    .sort((a, b) => (a.place ?? Number.MAX_SAFE_INTEGER) - (b.place ?? Number.MAX_SAFE_INTEGER) || b.chips - a.chips);
  return [...playing, ...finished].map((e, i) => ({ ...e, rank: e.place ?? i + 1 }));
}
