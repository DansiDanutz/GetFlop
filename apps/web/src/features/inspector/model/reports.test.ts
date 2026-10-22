import { describe, expect, it } from 'vitest';
import { bandPositions, clubDay, collapseInside, localInputToIso, pct, periodQuery, shiftDay, toCsv, type MarketStat } from './reports';

const tz = 'Europe/Athens';

describe('period chips', () => {
  it('uses club days that start at 06:00 local', () => {
    expect(clubDay(new Date('2026-09-24T18:00:00Z'), tz)).toBe('2026-09-24');
    expect(clubDay(new Date('2026-09-24T02:00:00Z'), tz)).toBe('2026-09-23');
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('turns chips into query parameters', () => {
    const now = new Date('2026-09-24T18:00:00Z');
    expect(periodQuery('today', now, tz)).toEqual({ dateStart: '2026-09-24', dateEnd: '2026-09-24' });
    expect(periodQuery('7d', now, tz)).toEqual({ dateStart: '2026-09-18', dateEnd: '2026-09-24' });
    expect(periodQuery('30d', now, tz)).toEqual({ dateStart: '2026-08-26', dateEnd: '2026-09-24' });
    expect(periodQuery('all', now, tz)).toEqual({ all: 1 });
    expect(periodQuery('custom', now, tz, { from: '2026-09-01', to: '2026-09-02' })).toEqual({ dateStart: '2026-09-01', dateEnd: '2026-09-02' });
  });
});

describe('hold figures', () => {
  const stat = (over: Partial<MarketStat>): MarketStat => ({
    slug: 'rainbow', picks: 100, hits: 40, expectedHits: 39.8, handleCents: 10_000, paidCents: 9_000, resultCents: 1_000,
    holdPct: 0.1, theoHoldPct: 0.085, lowPct: -0.05, highPct: 0.22, verdict: 'inside', ...over,
  });

  it('formats percentages', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(-0.5, 0)).toBe('-50%');
    expect(pct(null)).toBe('—');
  });

  it('collapses markets inside their band', () => {
    const r = collapseInside([stat({}), stat({ slug: 'a', verdict: 'above' }), stat({ slug: 'b', verdict: 'low_volume' })]);
    expect(r.listed.map((s) => s.slug)).toEqual(['a', 'b']);
    expect(r.insideCount).toBe(1);
  });

  it('places the band, the theoretical hold and the actual hold on one scale', () => {
    expect(bandPositions(stat({}))).toEqual({ low: 0, high: 100, theo: 50, actual: 55.6 });
    expect(bandPositions(stat({ holdPct: null })).actual).toBeNull();
  });
});

describe('csv and inputs', () => {
  it('quotes and guards cells', () => {
    expect(toCsv(['a'], [['x,y'], ['=1+1'], [-3]])).toBe('a\r\n"x,y"\r\n\'=1+1\r\n-3\r\n');
  });
  it('parses a datetime-local value', () => {
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('2026-09-24T18:00')).toMatch(/^2026-09-2\dT/);
  });
});
