import { describe, expect, it } from 'vitest';
import { parseFlop } from './cards.js';
import {
  buildCoupon, commitmentCents, payoutCents, settleRound, topWinCents, unplayedRefundCents,
  type CouponContext,
} from './coupon.js';
import { DEFAULT_LIMITS, autoMarketMaxCents, marketMaxCents, validateLimits } from './limits.js';
import { MARKETS } from './markets.js';

const OFFERED = new Set(MARKETS.filter((m) => m.enabledByDefault).map((m) => m.slug));
const CTX: CouponContext = { offered: OFFERED, limits: DEFAULT_LIMITS, balanceCents: 1_000_000 };

describe('automatic market limits (50 PTS table)', () => {
  it.each([
    [2.3, 5_000], [16, 5_000], [24, 4_000], [30, 3_000], [60, 1_500], [170, 500], [100_000, 100],
  ])('×%f → %i cents', (mult, expected) => {
    expect(autoMarketMaxCents(mult, DEFAULT_LIMITS)).toBe(expected);
  });

  it('prefers a positive override and never goes below the table minimum', () => {
    expect(marketMaxCents('rainbow', { ...DEFAULT_LIMITS, marketMaxCents: { rainbow: 300 } })).toBe(300);
    expect(marketMaxCents('rainbow', { ...DEFAULT_LIMITS, marketMaxCents: { rainbow: 0 } })).toBe(5_000);
    expect(marketMaxCents('trips-or-sf', { ...DEFAULT_LIMITS, minCents: 800 })).toBe(800);
  });

  it('validates limits', () => {
    expect(validateLimits(DEFAULT_LIMITS)).toBeNull();
    expect(validateLimits({ ...DEFAULT_LIMITS, minCents: 0 })).toBe('limits_invalid');
    expect(validateLimits({ ...DEFAULT_LIMITS, maxCents: 50 })).toBe('limits_max_below_min');
    expect(validateLimits({ ...DEFAULT_LIMITS, couponCapCents: 50 })).toBe('limits_cap_below_min');
    expect(validateLimits({ ...DEFAULT_LIMITS, marketMaxCents: { rainbow: 50 } })).toBe('limits_market_invalid');
  });
});

describe('buildCoupon', () => {
  const req = { selections: [{ market: 'rainbow', stakeCents: 200 }, { market: 'any-pair', stakeCents: 100 }], rounds: 10 };

  it('locks the multipliers at placement', () => {
    expect(buildCoupon(req, CTX)).toEqual({
      ok: true,
      value: [
        { market: 'rainbow', stakeCents: 200, multiplier: 2.3 },
        { market: 'any-pair', stakeCents: 100, multiplier: 5 },
      ],
    });
    expect(commitmentCents(req)).toBe(3_000);
  });

  it('uses the multiplier in force when given', () => {
    const result = buildCoupon(req, { ...CTX, multiplierOf: () => 2 });
    expect(result.ok && result.value[0]!.multiplier).toBe(2);
  });

  const one = (market: string, stakeCents: number, rounds = 1) => ({ selections: [{ market, stakeCents }], rounds });
  it.each([
    [{ selections: [], rounds: 1 }, 'coupon.no_selections'],
    [{ selections: [{ market: 'rainbow', stakeCents: 100 }, { market: 'rainbow', stakeCents: 100 }], rounds: 1 }, 'coupon.duplicate_selections'],
    [one('any-trips', 100), 'coupon.not_on_menu_table'],
    [one('rainbow', 100, 0), 'coupon.bad_rounds'],
    [one('rainbow', 100, 1.5), 'coupon.bad_rounds'],
    [one('rainbow', 100, 21), 'coupon.max_rounds_table'],
    [one('rainbow', 0), 'coupon.bad_stake'],
    [one('rainbow', 50), 'coupon.min_stake'],
    [one('rainbow', 5_100), 'coupon.max_stake'],
    [one('trips-or-sf', 600), 'coupon.max_stake_market'],
    [one('rainbow', 2_100, 10), 'coupon.over_commitment'],
  ])('rejects %o with %s', (bad, error) => {
    expect(buildCoupon(bad, CTX)).toMatchObject({ ok: false, error });
  });

  it('skips the coupon cap in tournaments', () => {
    expect(buildCoupon(one('rainbow', 2_100, 10), { ...CTX, skipCommitmentCap: true }).ok).toBe(true);
  });

  it('rejects when the balance does not cover the commitment', () => {
    expect(buildCoupon(req, { ...CTX, balanceCents: 2_999 })).toMatchObject({ ok: false, error: 'coupon.insufficient_balance' });
  });
});

describe('settlement', () => {
  const legs = [
    { market: 'rainbow', stakeCents: 200, multiplier: 2.3 },
    { market: 'any-pair', stakeCents: 200, multiplier: 5 },
  ];

  it('pays winning legs stake × multiplier without float drift', () => {
    expect(payoutCents(200, 2.3)).toBe(460);
    expect(settleRound(legs, parseFlop(['Qc', '7h', '3s']))).toEqual([
      { market: 'rainbow', won: true, payoutCents: 460 },
      { market: 'any-pair', won: false, payoutCents: 0 },
    ]);
  });

  it('refunds unplayed rounds and computes the top win', () => {
    expect(unplayedRefundCents(legs, 3)).toBe(1_200);
    expect(topWinCents(legs, 2)).toBe((460 + 1_000) * 2);
  });
});
