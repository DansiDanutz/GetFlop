import { describe, expect, it } from 'vitest';
import {
  edgeOf, fairOdds, marketProbability, oddsToMultiplierX100, marketVerdict, wilsonInterval, MIN_PICKS_TO_JUDGE,
} from './stats.js';

describe('market maths', () => {
  it('computes exact chances over all 22,100 flops', () => {
    expect(marketProbability('rainbow')).toBeCloseTo(8_788 / 22_100, 9);
    expect(marketProbability('any-pair')).toBeCloseTo(3_744 / 22_100, 9);
    expect(marketProbability('trips-or-sf')).toBeCloseTo(100 / 22_100, 9);
  });

  it('returns 0 for an unknown market', () => {
    expect(marketProbability('nope')).toBe(0);
  });

  it('derives the fair odds and the house edge', () => {
    const p = marketProbability('rainbow');
    expect(fairOdds(p)).toBeCloseTo(1 / p - 1, 9);
    expect(edgeOf(1.3, p)).toBeCloseTo(1 - 2.3 * p, 9);
    expect(edgeOf(5, p)).toBeLessThan(0);
    expect(fairOdds(0)).toBe(0);
  });

  it('converts X:1 odds to a stored multiplier ×100', () => {
    expect(oddsToMultiplierX100(1.3)).toBe(230);
    expect(oddsToMultiplierX100(59)).toBe(6_000);
    expect(oddsToMultiplierX100(0.005)).toBe(101);
  });
});

describe('Wilson interval verdict', () => {
  it('builds a 95% interval around the observed rate', () => {
    const { low, high } = wilsonInterval(40, 100);
    expect(low).toBeCloseTo(0.3094, 3);
    expect(high).toBeCloseTo(0.4980, 3);
  });

  it('returns the full range with no picks', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('refuses to judge under the minimum sample', () => {
    expect(marketVerdict(10, MIN_PICKS_TO_JUDGE - 1, 0.4)).toBe('too_few');
  });

  it('tells hitting more, less, or as priced', () => {
    expect(marketVerdict(80, 100, 0.4)).toBe('more');
    expect(marketVerdict(10, 100, 0.4)).toBe('less');
    expect(marketVerdict(40, 100, 0.4)).toBe('as_priced');
  });
});
