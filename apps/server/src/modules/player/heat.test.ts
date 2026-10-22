import { parseFlop } from '@getflop/engine';
import { describe, expect, it } from 'vitest';
import { bandFor, computeHeat, HEAT_MARKETS, marketProbability } from './heat.js';

const flop = (a: string, b: string, c: string) => parseFlop([a, b, c]);
const RAINBOW_NO_PAIR = flop('Qc', '7h', '3s');

describe('marketProbability', () => {
  it('matches the exact counts over 22,100 flops', () => {
    expect(marketProbability('rainbow')).toBeCloseTo(8_788 / 22_100, 10);
    expect(marketProbability('any-pair')).toBeCloseTo(3_744 / 22_100, 10);
    expect(marketProbability('straight-flush')).toBeCloseTo(48 / 22_100, 10);
  });
});

describe('bandFor', () => {
  it('is expected ± 2 standard deviations of a binomial, as rates, clamped to [0, 1]', () => {
    const p = 0.2;
    const band = bandFor(p, 50);
    const sigma = Math.sqrt(50 * p * (1 - p));
    expect(band.low).toBeCloseTo((50 * p - 2 * sigma) / 50, 10);
    expect(band.high).toBeCloseTo((50 * p + 2 * sigma) / 50, 10);
  });

  it('never goes below zero for rare markets', () => {
    expect(bandFor(0.002, 50).low).toBe(0);
  });

  it('collapses to the expected rate when nothing was counted', () => {
    expect(bandFor(0.3, 0)).toEqual({ low: 0.3, high: 0.3 });
  });
});

describe('computeHeat', () => {
  it('reports hits, the sequence oldest first and no verdict before the window is full', () => {
    const board = computeHeat([RAINBOW_NO_PAIR, flop('7h', '7d', '2h')], 50);
    expect(board.flopsCounted).toBe(2);
    const rainbow = board.markets.find((m) => m.slug === 'rainbow')!;
    expect(rainbow).toMatchObject({ hits: 1, hitSeq: [true, false], judged: false, state: 'normal' });
    expect(board.markets.find((m) => m.slug === 'any-pair')!.hitSeq).toEqual([false, true]);
    expect(board.hot).toEqual([]);
    expect(board.cold).toEqual([]);
  });

  it('covers the heat markets in catalogue order with names and expected rates', () => {
    const board = computeHeat([], 50);
    expect(board.markets.map((m) => m.slug)).toEqual([...HEAT_MARKETS]);
    expect(board.markets[0]).toMatchObject({ slug: 'rainbow', name: 'Rainbow', hits: 0, rate: 0 });
    expect(board.markets[0]!.expected).toBeCloseTo(0.397647, 5);
  });

  it('calls a market hot above the band and cold below it once the window is full', () => {
    const board = computeHeat(Array.from({ length: 50 }, () => RAINBOW_NO_PAIR), 50);
    const rainbow = board.markets.find((m) => m.slug === 'rainbow')!;
    expect(rainbow).toMatchObject({ hits: 50, rate: 1, judged: true, state: 'hot' });
    expect(board.hot).toContain('rainbow');
    // Any Pair is expected ~8.5 times in 50 flops: zero is far below the band.
    expect(board.cold).toContain('any-pair');
    // Trips cannot be cold in 50 flops: its band starts at zero.
    expect(board.markets.find((m) => m.slug === 'any-trips')!.state).toBe('normal');
  });

  it('keeps only the last `window` flops', () => {
    const flops = [flop('7h', '7d', '2h'), ...Array.from({ length: 10 }, () => RAINBOW_NO_PAIR)];
    const board = computeHeat(flops, 10);
    expect(board.flopsCounted).toBe(10);
    expect(board.markets.find((m) => m.slug === 'any-pair')!.hits).toBe(0);
  });

  it('orders the hot list by how far above the band a market is', () => {
    const allHearts = flop('2h', '7h', 'Kh');
    const board = computeHeat(Array.from({ length: 50 }, () => allHearts), 50);
    // Flush (p≈5%) at 100% is further out than All Same Color (p≈24%) at 100%.
    expect(board.hot.indexOf('any-flush')).toBeLessThan(board.hot.indexOf('same-color'));
  });
});
