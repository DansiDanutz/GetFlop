import { describe, expect, it } from 'vitest';
import {
  clampRounds, clampStake, commitmentCents, estimatedMinutes, marketMax, perFlopCents, playAgain, quickAmounts,
  setPickStake, setSharedAmount, slipIssue, togglePick, topWinCents,
} from './slip';
import type { OfferedMarket, TableLimits } from './types';

const LIMITS: TableLimits = { minCents: 100, maxCents: 5_000, couponCapCents: 20_000, maxRounds: 20, marketMaxCents: {} };
const OFFERED: OfferedMarket[] = [
  { slug: 'rainbow', name: 'Rainbow', group: 'popular', multiplier: 2.3 },
  { slug: 'any-pair', name: 'Any Pair', group: 'popular', multiplier: 5 },
  { slug: 'pair-aces', name: 'Pair of Aces', group: 'pairs', multiplier: 60 },
  { slug: 'trips-or-sf', name: 'Trips or Straight Flush', group: 'specials', multiplier: 170 },
];

describe('per-market limits', () => {
  it('follows the automatic long-shot limit and explicit overrides', () => {
    expect(marketMax('rainbow', LIMITS)).toBe(5_000);
    expect(marketMax('pair-aces', LIMITS)).toBe(1_500);
    expect(marketMax('trips-or-sf', LIMITS)).toBe(500);
    expect(marketMax('rainbow', { ...LIMITS, marketMaxCents: { rainbow: 800 } })).toBe(800);
  });

  it('clamps a stake between the table minimum and the market maximum', () => {
    expect(clampStake(50, 'rainbow', LIMITS)).toBe(100);
    expect(clampStake(9_999, 'trips-or-sf', LIMITS)).toBe(500);
    expect(clampStake(300, 'any-pair', LIMITS)).toBe(300);
  });

  it('offers quick amounts inside the table limits only', () => {
    expect(quickAmounts(LIMITS)).toEqual([100, 200, 500, 1_000, 2_000, 5_000]);
    expect(quickAmounts({ ...LIMITS, minCents: 300, maxCents: 1_000 })).toEqual([500, 1_000]);
  });
});

describe('editing the slip', () => {
  it('adds a pick at the shared amount clamped to its market, and removes it on a second tap', () => {
    const one = togglePick([], 'trips-or-sf', 2_000, LIMITS);
    expect(one).toEqual([{ market: 'trips-or-sf', stakeCents: 500 }]);
    expect(togglePick(one, 'trips-or-sf', 2_000, LIMITS)).toEqual([]);
  });

  it('applies a new shared amount to every pick without mutating the old slip', () => {
    const picks = [{ market: 'rainbow', stakeCents: 100 }, { market: 'pair-aces', stakeCents: 100 }];
    const next = setSharedAmount(picks, 2_000, LIMITS);
    expect(next).toEqual([{ market: 'rainbow', stakeCents: 2_000 }, { market: 'pair-aces', stakeCents: 1_500 }]);
    expect(picks[0]!.stakeCents).toBe(100);
  });

  it('edits one pick only', () => {
    const picks = [{ market: 'rainbow', stakeCents: 100 }, { market: 'any-pair', stakeCents: 100 }];
    expect(setPickStake(picks, 'any-pair', 700, LIMITS)).toEqual([{ market: 'rainbow', stakeCents: 100 }, { market: 'any-pair', stakeCents: 700 }]);
  });

  it('clamps rounds to 1..table max', () => {
    expect(clampRounds(0, 20)).toBe(1);
    expect(clampRounds(25, 20)).toBe(20);
    expect(clampRounds(7, 20)).toBe(7);
  });
});

describe('slip math', () => {
  const picks = [{ market: 'rainbow', stakeCents: 200 }, { market: 'any-pair', stakeCents: 100 }];

  it('totals the amount per flop and the commitment over every flop', () => {
    expect(perFlopCents(picks)).toBe(300);
    expect(commitmentCents(picks, 10)).toBe(3_000);
  });

  it('computes the top win as every pick winning on every flop, stake included', () => {
    // 2 PTS × 2.3 = 4.60, 1 PT × 5 = 5.00 → 9.60 per flop × 3 flops.
    expect(topWinCents(picks, 3, OFFERED)).toBe(2_880);
  });

  it('floors each payout like the server', () => {
    expect(topWinCents([{ market: 'rainbow', stakeCents: 101 }], 1, OFFERED)).toBe(232);
  });

  it('estimates about 2.2 minutes per flop', () => {
    expect(estimatedMinutes(10)).toBe(22);
    expect(estimatedMinutes(1)).toBe(2);
  });
});

describe('slipIssue (priority order)', () => {
  const base = {
    picks: [{ market: 'rainbow', stakeCents: 200 }], rounds: 5, limits: LIMITS, unit: 'points' as const,
    balanceCents: 10_000, blockedBy: null, serverError: null,
  };

  it('is clear for a valid slip', () => {
    expect(slipIssue(base)).toBeNull();
  });

  it('shows the last server error first', () => {
    expect(slipIssue({ ...base, blockedBy: 'staff', serverError: 'coupon.table_closed' }))
      .toEqual({ kind: 'server', code: 'coupon.table_closed' });
  });

  it('then the play block', () => {
    expect(slipIssue({ ...base, blockedBy: 'watch', balanceCents: 0 })).toEqual({ kind: 'blocked', reason: 'watch' });
  });

  it('then an amount outside the limits', () => {
    expect(slipIssue({ ...base, picks: [{ market: 'trips-or-sf', stakeCents: 600 }], balanceCents: 0 }))
      .toEqual({ kind: 'amount', market: 'trips-or-sf', min: 100, max: 500 });
  });

  it('then the commitment cap, which tournaments do not have', () => {
    const big = { ...base, picks: [{ market: 'rainbow', stakeCents: 5_000 }], rounds: 5, balanceCents: 0 };
    expect(slipIssue(big)).toEqual({ kind: 'cap', max: 20_000 });
    expect(slipIssue({ ...big, unit: 'chips' })).toEqual({ kind: 'balance' });
  });

  it('then the balance', () => {
    expect(slipIssue({ ...base, balanceCents: 999 })).toEqual({ kind: 'balance' });
  });
});

describe('playAgain', () => {
  it('drops markets not on the table, clamps amounts and rounds, and reports the changes', () => {
    const result = playAgain(
      [
        { market: 'rainbow', stakeCents: 200 },
        { market: 'flush-hearts', stakeCents: 100 },
        { market: 'trips-or-sf', stakeCents: 2_000 },
        { market: 'any-pair', stakeCents: 50 },
      ],
      30,
      { limits: LIMITS, offered: OFFERED },
    );
    expect(result.picks).toEqual([
      { market: 'rainbow', stakeCents: 200 },
      { market: 'trips-or-sf', stakeCents: 500 },
      { market: 'any-pair', stakeCents: 100 },
    ]);
    expect(result).toMatchObject({ rounds: 20, dropped: 1, adjusted: 2, roundsClamped: true, empty: false });
  });

  it('says so when nothing fits', () => {
    const result = playAgain([{ market: 'flush-hearts', stakeCents: 100 }], 3, { limits: LIMITS, offered: OFFERED });
    expect(result).toMatchObject({ picks: [], dropped: 1, empty: true, roundsClamped: false });
  });
});
