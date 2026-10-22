import { describe, expect, it } from 'vitest';
import { toCsv } from './csv.js';
import { MIN_PICKS_FOR_HOLD, marketStats, probabilityOf, theoreticalHold, totals, type BetFact } from './metrics.js';

const bet = (over: Partial<BetFact> = {}): BetFact => ({
  handId: 'h1', userId: 'u1', market: 'rainbow', stakeCents: 200, multiplierX100: 230, payoutCents: 0, status: 'lost', ...over,
});

describe('market probabilities', () => {
  it('counts exact flop odds from the full deck', () => {
    // 3 suits out of 4 on a flop: 13·13·13·24 / 22100·6 → 0.3976
    expect(probabilityOf('rainbow')).toBeCloseTo(0.397647, 5);
    expect(probabilityOf('flush-hearts')).toBeCloseTo(286 / 22_100, 8);
  });
  it('computes theoretical hold as 1 − multiplier × probability', () => {
    expect(theoreticalHold('rainbow', 230)).toBeCloseTo(1 - 2.3 * 0.397647, 5);
  });
});

describe('totals', () => {
  it('sums handle, paid, result and hold %', () => {
    const t = totals([
      bet({ status: 'won', payoutCents: 460 }),
      bet({ handId: 'h2', userId: 'u2', stakeCents: 300 }),
      bet({ handId: 'h2', userId: 'u2', market: 'any-pair', stakeCents: 500, multiplierX100: 500 }),
    ]);
    expect(t).toEqual({ picks: 3, hands: 2, players: 2, handleCents: 1000, paidCents: 460, resultCents: 540, holdPct: 0.54 });
  });
  it('has no hold % without handle', () => {
    expect(totals([]).holdPct).toBeNull();
  });
});

describe('marketStats', () => {
  it('flags low volume below the pick threshold', () => {
    const [m] = marketStats([bet(), bet({ status: 'won', payoutCents: 460 })]);
    expect(m).toMatchObject({ slug: 'rainbow', picks: 2, hits: 1, verdict: 'low_volume', handleCents: 400, paidCents: 460, resultCents: -60 });
    expect(m!.expectedHits).toBeCloseTo(2 * 0.397647, 5);
  });

  it('places a hold inside or outside the 95% band', () => {
    const n = MIN_PICKS_FOR_HOLD * 4;
    const expectedWins = Math.round(n * probabilityOf('rainbow'));
    const fair = Array.from({ length: n }, (_, i) => bet({ handId: `h${i}`, ...(i < expectedWins ? { status: 'won', payoutCents: 460 } : {}) }));
    const [inside] = marketStats(fair);
    expect(inside!.verdict).toBe('inside');
    expect(inside!.lowPct).toBeLessThan(inside!.theoHoldPct);
    expect(inside!.highPct).toBeGreaterThan(inside!.theoHoldPct);

    const allLost = Array.from({ length: n }, (_, i) => bet({ handId: `h${i}` }));
    expect(marketStats(allLost)[0]!.verdict).toBe('above');
    const allWon = allLost.map((b) => ({ ...b, status: 'won', payoutCents: 460 }));
    expect(marketStats(allWon)[0]!.verdict).toBe('below');
  });
});

describe('toCsv', () => {
  it('quotes separators and neutralises formulas', () => {
    expect(toCsv(['A', 'B'], [['x,y', 'say "hi"'], ['=cmd()', -5]])).toBe('A,B\r\n"x,y","say ""hi"""\r\n\'=cmd(),-5\r\n');
  });
});
