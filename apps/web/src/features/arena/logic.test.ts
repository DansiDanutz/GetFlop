import { describe, expect, it } from 'vitest';
import {
  badgeRemaining, capLines, fmtParams, isSafeCheckoutUrl, clockEndsAt, durationText, handResultFor, maxStakePerPick, readReturn, refillLine, slipProblem, slipTotals,
} from './logic';

describe('slip', () => {
  const picks = [{ market: 'rainbow', multiplier: 2.3 }, { market: 'any-pair', multiplier: 5 }];

  it('totals the commitment and the top win', () => {
    expect(slipTotals(picks, 1_000, 3)).toEqual({ perFlopCents: 2_000, commitmentCents: 6_000, topWinCents: (2_300 + 5_000) * 3 });
  });

  it('reports the first problem in priority order', () => {
    const base = { minCents: 1_000, maxRounds: 20, balanceCents: 10_000 };
    expect(slipProblem({ ...base, pickCount: 0, stakeCents: 1_000, rounds: 1 })).toEqual({ key: 'arena_slip_pick_first' });
    expect(slipProblem({ ...base, pickCount: 1, stakeCents: 500, rounds: 1 })).toEqual({ key: 'arena_slip_min', params: { min: 1_000 } });
    expect(slipProblem({ ...base, pickCount: 1, stakeCents: 1_000, rounds: 21 })).toEqual({ key: 'arena_slip_rounds', params: { max: 20 } });
    expect(slipProblem({ ...base, pickCount: 2, stakeCents: 1_000, rounds: 6 })).toEqual({ key: 'arena_slip_balance' });
    expect(slipProblem({ ...base, pickCount: 2, stakeCents: 1_000, rounds: 5 })).toBeNull();
  });

  it('computes MAX as whole Stars that fit the balance', () => {
    expect(maxStakePerPick(12_345, 2, 3, 1_000)).toBe(2_000);
    expect(maxStakePerPick(1_500, 2, 1, 1_000)).toBe(0);
    expect(maxStakePerPick(5_000, 0, 1, 1_000)).toBe(5_000);
  });
});

describe('clock and time', () => {
  it('anchors the phase end to when the answer arrived', () => {
    expect(clockEndsAt({ phase: 'open', remainingMs: 12_000 }, 1_000)).toBe(new Date(13_000).toISOString());
    expect(clockEndsAt({ phase: 'asleep', remainingMs: 0 }, 1_000)).toBeNull();
  });

  it('writes durations compactly', () => {
    expect(durationText(45_000)).toBe('45s');
    expect(durationText(3_720_000)).toBe('1h 2m');
    expect(durationText(2 * 86_400_000 + 3_600_000)).toBe('2d 1h');
    expect(durationText(-5)).toBe('0s');
  });
});

describe('refill and caps', () => {
  it('picks the refill line', () => {
    const r = { underCents: 50_000, targetCents: 200_000, amountCents: 170_000, ready: true, nextAt: null };
    expect(refillLine(r, 0)).toEqual({ key: 'arena_refill_ready', params: { amount: 170_000 } });
    expect(refillLine({ ...r, ready: false, nextAt: new Date(3_600_000).toISOString() }, 0))
      .toEqual({ key: 'arena_refill_next', params: { amount: 170_000, in: '1h 0m' } });
    expect(refillLine({ ...r, ready: false, amountCents: 200_000 }, 0)).toEqual({ key: 'arena_refill_rule', params: { amount: 200_000, under: 50_000 } });
  });

  it('shows what is left of the day and month caps', () => {
    expect(capLines({ capDayCents: 3_000, capMonthCents: 10_000, leftDayCents: 522, leftMonthCents: 7_522 })).toEqual([
      { key: 'arena_cap_day_left', params: { left: 522, cap: 3_000 } },
      { key: 'arena_cap_month_left', params: { left: 7_522, cap: 10_000 } },
    ]);
  });

  it('counts what is left to the next badge', () => {
    expect(badgeRemaining({ current: 7, target: 10 })).toBe(3);
    expect(badgeRemaining({ current: 12, target: 10 })).toBe(0);
    expect(badgeRemaining(null)).toBe(0);
  });
});

describe('returns and results', () => {
  it('reads the payment return parameters', () => {
    expect(readReturn('?order=o1&stars=success&simulate=1')).toEqual({ orderId: 'o1', outcome: 'success', simulate: true });
    expect(readReturn('?order=o1&stars=cancel')).toEqual({ orderId: 'o1', outcome: 'cancel', simulate: false });
    expect(readReturn('?stars=weird')).toBeNull();
  });

  it('extracts my picks from a settled hand', () => {
    const payload = {
      tableId: 't', handId: 'h', card1: 'Ah', card2: 'Ad', card3: 'Kh', matchingSlugs: ['any-pair'],
      winners: [{ userId: 'me', betTypeSlug: 'any-pair', amountCents: 1_000, payoutCents: 5_000 }, { userId: 'x', betTypeSlug: 'any-pair', amountCents: 1, payoutCents: 5 }],
      losers: [{ userId: 'me', betTypeSlug: 'rainbow', amountCents: 1_000, payoutCents: 0 }],
    };
    expect(handResultFor(payload, 'me')).toEqual({
      flop: ['Ah', 'Ad', 'Kh'], matching: ['any-pair'], won: [{ market: 'any-pair', stakeCents: 1_000, payoutCents: 5_000 }],
      lost: [{ market: 'rainbow', stakeCents: 1_000, payoutCents: 0 }], netCents: 3_000,
    });
    expect(handResultFor(payload, 'nobody')).toBeNull();
  });
});

describe('small helpers', () => {
  it('follows only http(s) checkout pages', () => {
    expect(isSafeCheckoutUrl('https://checkout.example/c/1')).toBe(true);
    expect(isSafeCheckoutUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeCheckoutUrl('not a url')).toBe(false);
  });

  it('formats Star amounts in line params only', () => {
    expect(fmtParams({ amount: 170_000, in: '1h', n: 3 })).toEqual({ amount: '1,700 ★', in: '1h', n: 3 });
    expect(fmtParams(undefined)).toEqual({});
  });
});
