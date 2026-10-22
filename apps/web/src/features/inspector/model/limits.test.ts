import { describe, expect, it } from 'vitest';
import { autoLimitCents, buildLimits, formFromLimits, groupMarkets, initialSelection, selectionPayload, toCents } from './limits';

const markets = [
  { slug: 'rainbow', name: 'Rainbow', group: 'popular', multiplier: 2.3 },
  { slug: 'straight', name: 'Three Consecutive', group: 'runs', multiplier: 24 },
  { slug: 'trips-or-sf', name: 'Trips', group: 'specials', multiplier: 170 },
];

describe('market selection', () => {
  it('groups markets in catalogue order', () => {
    expect(groupMarkets(markets).map((g) => g.group)).toEqual(['popular', 'specials', 'runs']);
  });
  it('sends [] when every market is ticked', () => {
    expect(selectionPayload(new Set(['rainbow', 'straight', 'trips-or-sf']), markets)).toEqual([]);
    expect(selectionPayload(new Set(['straight']), markets)).toEqual(['straight']);
    expect([...initialSelection([], markets)]).toEqual(['rainbow', 'straight', 'trips-or-sf']);
    expect([...initialSelection(['rainbow'], markets)]).toEqual(['rainbow']);
  });
});

describe('automatic per-market limits', () => {
  it('follows min and max live (≤ n placeholder)', () => {
    expect(autoLimitCents(2.3, 100, 5_000)).toBe(5_000);
    expect(autoLimitCents(24, 100, 5_000)).toBe(4_000);
    expect(autoLimitCents(170, 100, 5_000)).toBe(500);
    expect(autoLimitCents(170, 1_000, 5_000)).toBe(1_000);
    expect(autoLimitCents(24, 100, 10_000)).toBe(8_000);
  });
});

describe('limits form', () => {
  const form = { min: '1', max: '50', cap: '200', rounds: '20', markets: { straight: '', rainbow: '30' } };
  it('builds the payload, leaving empty market fields automatic', () => {
    expect(buildLimits(form)).toEqual({ ok: true, value: { minCents: 100, maxCents: 5_000, couponCapCents: 20_000, maxRounds: 20, marketMaxCents: { rainbow: 3_000 } } });
  });
  it('rejects invalid values', () => {
    expect(buildLimits({ ...form, min: '0' })).toMatchObject({ ok: false, error: 'insp_limits_invalid' });
    expect(buildLimits({ ...form, max: '0.5' })).toMatchObject({ ok: false, error: 'insp_limits_max_below_min' });
    expect(buildLimits({ ...form, cap: '0.5' })).toMatchObject({ ok: false, error: 'insp_limits_cap_below_min' });
    expect(buildLimits({ ...form, markets: { rainbow: '0.2' } })).toEqual({ ok: false, error: 'insp_limits_market_invalid', slug: 'rainbow' });
    expect(toCents('1.234')).toBeNull();
    expect(toCents('2,5')).toBe(250);
  });
  it('round-trips stored limits', () => {
    expect(formFromLimits({ minCents: 150, maxCents: 5_000, couponCapCents: 20_000, maxRounds: 10, marketMaxCents: { rainbow: 1_000 } }))
      .toEqual({ min: '1.50', max: '50', cap: '200', rounds: '10', markets: { rainbow: '10' } });
  });
});
