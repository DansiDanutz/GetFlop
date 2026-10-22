import { describe, expect, it } from 'vitest';
import { allAmountText, checkAmount, guidanceKey, pendingFor, quickChips, type PointRequest } from './amounts';

describe('checkAmount', () => {
  it('asks for an amount when the field is empty', () => {
    expect(checkAmount('', 'request', 0)).toEqual({ ok: false, error: 'empty' });
    expect(checkAmount('   ', 'return', 500)).toEqual({ ok: false, error: 'empty' });
  });

  it('accepts a dot or a comma and at most two decimals', () => {
    expect(checkAmount('12.5', 'request', 0)).toEqual({ ok: true, cents: 1_250 });
    expect(checkAmount('12,55', 'request', 0)).toEqual({ ok: true, cents: 1_255 });
    expect(checkAmount('12.555', 'request', 0)).toEqual({ ok: false, error: 'invalid' });
    expect(checkAmount('abc', 'request', 0)).toEqual({ ok: false, error: 'invalid' });
  });

  it('refuses zero', () => {
    expect(checkAmount('0', 'request', 0)).toEqual({ ok: false, error: 'invalid' });
    expect(checkAmount('0.00', 'return', 100)).toEqual({ ok: false, error: 'invalid' });
  });

  it('lets requests exceed the balance but not returns', () => {
    expect(checkAmount('500', 'request', 100)).toEqual({ ok: true, cents: 50_000 });
    expect(checkAmount('2', 'return', 100)).toEqual({ ok: false, error: 'over_balance' });
    expect(checkAmount('1', 'return', 100)).toEqual({ ok: true, cents: 100 });
  });

  it('says there is nothing to return with a zero balance', () => {
    expect(checkAmount('1', 'return', 0)).toEqual({ ok: false, error: 'nothing_to_return' });
    expect(checkAmount('', 'return', 0)).toEqual({ ok: false, error: 'nothing_to_return' });
  });
});

describe('quickChips', () => {
  it('offers fixed request sizes', () => {
    expect(quickChips('request', 0)).toEqual([1_000, 2_000, 5_000, 10_000]);
  });

  it('scales return chips to the balance (the four largest steps that fit)', () => {
    expect(quickChips('return', 3_700)).toEqual([200, 500, 1_000, 2_000]);
    expect(quickChips('return', 250_000)).toEqual([20_000, 50_000, 100_000, 200_000]);
    expect(quickChips('return', 150)).toEqual([100]);
    expect(quickChips('return', 50)).toEqual([]);
  });
});

describe('allAmountText', () => {
  it('writes the whole balance with the decimal separator of the language', () => {
    expect(allAmountText(12_345, 'en')).toBe('123.45');
    expect(allAmountText(12_345, 'el')).toBe('123,45');
    expect(allAmountText(10_000, 'en')).toBe('100');
    expect(allAmountText(10_050, 'el')).toBe('100,5');
  });
});

describe('guidanceKey', () => {
  it('explains what to type on each side', () => {
    expect(guidanceKey('request', 0)).toBe('me_points_guide_request');
    expect(guidanceKey('return', 0)).toBe('me_points_guide_nothing');
    expect(guidanceKey('return', 10)).toBe('me_points_guide_return');
  });
});

describe('pendingFor', () => {
  const req = (id: string, kind: 'load' | 'cashout', status: PointRequest['status']): PointRequest =>
    ({ id, kind, status, amountCents: 100, createdAt: '2026-09-24T10:00:00Z' });

  it('finds the waiting request of the chosen side', () => {
    const lists = { reloads: [req('a', 'load', 'approved'), req('b', 'load', 'pending')], cashouts: [req('c', 'cashout', 'rejected')] };
    expect(pendingFor(lists, 'request')?.id).toBe('b');
    expect(pendingFor(lists, 'return')).toBeNull();
    expect(pendingFor(undefined, 'request')).toBeNull();
  });
});
