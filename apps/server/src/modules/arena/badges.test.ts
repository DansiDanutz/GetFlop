import { describe, expect, it } from 'vitest';
import { advanceProgress, badgeProgress, earnedBadges, EMPTY_PROGRESS, type FlopSummary, type Progress } from './badges.js';

const flop = (over: Partial<FlopSummary> = {}): FlopSummary => ({
  stakeCents: 1_000, paidCents: 0, picks: 1, picksWon: 0, markets: ['rainbow'], marketsWon: [], bestWinX100: 0, ...over,
});
const ctx = { day: '2026-09-24', week: '2026-09-21', balanceCents: 100_000, comebackFloorCents: 10_000, comebackPeakCents: 500_000 };

describe('advanceProgress', () => {
  it('counts flops, streaks and markets without mutating the input', () => {
    const start: Progress = { ...EMPTY_PROGRESS };
    const won = advanceProgress(start, flop({ picksWon: 1, paidCents: 2_300, marketsWon: ['rainbow'], bestWinX100: 230 }), ctx);
    expect(start.totalFlops).toBe(0);
    expect(won).toMatchObject({ totalFlops: 1, flopsWon: 1, winStreak: 1, bestWinStreak: 1, dayStreak: 1, lastPlayDay: '2026-09-24', marketsWon: ['rainbow'], bestHitX100: 230 });
    const lost = advanceProgress(won, flop({ markets: ['any-pair'] }), ctx);
    expect(lost).toMatchObject({ totalFlops: 2, winStreak: 0, bestWinStreak: 1, dayStreak: 1, marketsPlayed: ['any-pair', 'rainbow'] });
  });

  it('extends the day streak only on consecutive days', () => {
    let p = advanceProgress(EMPTY_PROGRESS, flop(), { ...ctx, day: '2026-09-20' });
    p = advanceProgress(p, flop(), { ...ctx, day: '2026-09-21' });
    p = advanceProgress(p, flop(), { ...ctx, day: '2026-09-21' });
    expect(p.dayStreak).toBe(2);
    p = advanceProgress(p, flop(), { ...ctx, day: '2026-09-23' });
    expect(p).toMatchObject({ dayStreak: 1, bestDayStreak: 2 });
  });
});

describe('earnedBadges', () => {
  it('awards counts, big hits, streaks and exploring badges', () => {
    const p: Progress = {
      ...EMPTY_PROGRESS, totalFlops: 100, bestWinStreak: 3, bestHitX100: 17_000, bestDayStreak: 7,
      marketsPlayed: ['a', 'b'], marketsWon: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
    };
    expect(earnedBadges(p, { offered: ['a', 'b'], comeback: false })).toEqual([
      'first_flop', 'flops_10', 'flops_100', 'hit_x170', 'hit_x40', 'three_in_a_row', 'every_market', 'week_streak', 'ten_markets_won',
    ]);
    expect(earnedBadges({ ...EMPTY_PROGRESS, totalFlops: 1, marketsPlayed: ['a'] }, { offered: ['a', 'b'], comeback: true }))
      .toEqual(['first_flop', 'comeback']);
  });

  it('detects the comeback within the same week only', () => {
    const low = { ...EMPTY_PROGRESS, lowWeek: '2026-09-21' };
    const rich = { ...ctx, balanceCents: 600_000 };
    expect(advanceProgress(low, flop(), rich).comeback).toBe(true);
    expect(advanceProgress({ ...low, lowWeek: '2026-09-14' }, flop(), rich).comeback).toBe(false);
  });
});

describe('badgeProgress', () => {
  it('shows how far the next step is', () => {
    const p = { ...EMPTY_PROGRESS, totalFlops: 7, winStreak: 1, bestWinStreak: 2, dayStreak: 3, bestDayStreak: 4, marketsPlayed: ['a'] };
    expect(badgeProgress('flops_10', p, 5, {})).toEqual({ current: 7, target: 10 });
    expect(badgeProgress('three_in_a_row', p, 5, {})).toEqual({ current: 1, target: 3, best: 2 });
    expect(badgeProgress('week_streak', p, 5, {})).toEqual({ current: 3, target: 7, best: 4 });
    expect(badgeProgress('every_market', p, 5, {})).toEqual({ current: 1, target: 5 });
    expect(badgeProgress('hit_x40', { ...p, bestHitX100: 2_400 }, 5, {})).toEqual({ current: 24, target: 40, best: 24 });
    expect(badgeProgress('week_top3', p, 5, { week_top3: 2 })).toEqual({ current: 2, target: 1 });
  });
});
