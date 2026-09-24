import { describe, expect, it } from 'vitest';
import { parseFlop } from './cards.js';
import { buildCoupon, commitmentCents, settleRound, unplayedRefundCents } from './coupon.js';
import { DEFAULT_LIMITS, autoMarketMaxCents, marketMaxCents, validateLimits } from './limits.js';
import { MARKETS } from './markets.js';

const OFFERED = new Set(MARKETS.filter((m) => m.enabledByDefault).map((m) => m.slug));
const RICH = 1_000_000;

describe('limits', () => {
  it('gives the ×170 long shot a 5 PTS automatic limit on a 50 PTS table', () => {
    expect(autoMarketMaxCents(170, DEFAULT_LIMITS)).toBe(500);
  });

  it('keeps favourites at the table maximum', () => {
    expect(autoMarketMaxCents(2.3, DEFAULT_LIMITS)).toBe(5_000);
  });

  it('prefers an explicit market limit', () => {
    const limits = { ...DEFAULT_LIMITS, marketMaxCents: { rainbow: 300 } };
    expect(marketMaxCents('rainbow', limits)).toBe(300);
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
  const req = { markets: ['rainbow', 'any-pair'], stakeCents: 200, rounds: 10 };

  it('locks the multipliers at placement', () => {
    const result = buildCoupon(req, OFFERED, DEFAULT_LIMITS, RICH);
    expect(result).toEqual({
      ok: true,
      value: [
        { market: 'rainbow', stakeCents: 200, multiplier: 2.3 },
        { market: 'any-pair', stakeCents: 200, multiplier: 5 },
      ],
    });
    expect(commitmentCents(req)).toBe(4_000);
  });

  it.each([
    [{ ...req, markets: [] }, 'coupon_empty'],
    [{ ...req, markets: ['rainbow', 'rainbow'] }, 'coupon_duplicate_market'],
    [{ ...req, markets: ['any-trips'] }, 'coupon_market_not_offered'],
    [{ ...req, rounds: 0 }, 'coupon_bad_rounds'],
    [{ ...req, rounds: 21 }, 'coupon_max_rounds_table'],
    [{ ...req, stakeCents: 50 }, 'stake_range'],
    [{ ...req, markets: ['trips-or-sf'], stakeCents: 600, rounds: 1 }, 'stake_range'],
    [{ ...req, stakeCents: 2_000 }, 'coupon_over_commitment'],
  ])('rejects %o with %s', (bad, error) => {
    expect(buildCoupon(bad, OFFERED, DEFAULT_LIMITS, RICH)).toEqual({ ok: false, error });
  });

  it('rejects when the balance does not cover the commitment', () => {
    expect(buildCoupon(req, OFFERED, DEFAULT_LIMITS, 3_999)).toEqual({ ok: false, error: 'insufficient_balance' });
  });
});

describe('settlement', () => {
  const legs = [
    { market: 'rainbow', stakeCents: 200, multiplier: 2.3 },
    { market: 'any-pair', stakeCents: 200, multiplier: 5 },
  ];

  it('pays winning legs stake × multiplier', () => {
    expect(settleRound(legs, parseFlop(['Qc', '7h', '3s']))).toEqual([
      { market: 'rainbow', won: true, payoutCents: 460 },
      { market: 'any-pair', won: false, payoutCents: 0 },
    ]);
  });

  it('refunds unplayed rounds', () => {
    expect(unplayedRefundCents(legs, 3)).toBe(1_200);
  });
});
