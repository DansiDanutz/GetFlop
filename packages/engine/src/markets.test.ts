import { describe, expect, it } from 'vitest';
import { allFlops, parseFlop } from './cards.js';
import { MARKETS, getMarket, isStraight, winningMarkets } from './markets.js';

const FLOPS = allFlops();
const hits = (slug: string) => FLOPS.filter(getMarket(slug).wins).length;
const margin = (slug: string) => 1 - (hits(slug) / FLOPS.length) * getMarket(slug).multiplier;

describe('market probabilities over all 22,100 flops', () => {
  it('enumerates 22,100 flops', () => {
    expect(FLOPS).toHaveLength(22_100);
  });

  it.each([
    ['rainbow', 8788], ['same-color', 5200], ['has-ace', 4804], ['any-pair', 3744],
    ['any-flush', 1144], ['all-lows', 1140], ['straight', 768], ['all-faces', 560],
    ['pair-aces', 288], ['pair-twos', 288], ['flush-hearts', 286], ['trips-or-sf', 100],
    ['any-trips', 52], ['straight-flush', 48],
  ])('%s hits on %i flops', (slug, expected) => {
    expect(hits(slug)).toBe(expected);
  });

  // Club margins published on the tour page.
  it.each([
    ['rainbow', 0.085], ['same-color', 0.106], ['has-ace', 0.1305], ['any-pair', 0.153],
    ['any-flush', 0.172], ['all-lows', 0.175], ['straight', 0.166], ['all-faces', 0.240],
    ['pair-kings', 0.218], ['flush-spades', 0.224], ['trips-or-sf', 0.231],
  ])('%s has a club margin of %f', (slug, expected) => {
    expect(margin(slug)).toBeCloseTo(expected, 3);
  });

  it('keeps every market profitable for the club', () => {
    for (const m of MARKETS) expect(margin(m.slug)).toBeGreaterThan(0);
  });
});

describe('market rules', () => {
  it('does not count trips as a pair', () => {
    const flop = parseFlop(['7h', '7d', '7c']);
    expect(getMarket('any-pair').wins(flop)).toBe(false);
    expect(getMarket('trips-or-sf').wins(flop)).toBe(true);
  });

  it('plays the ace high and low but never wraps', () => {
    expect(isStraight(parseFlop(['Ah', '2d', '3c']))).toBe(true);
    expect(isStraight(parseFlop(['Qh', 'Kd', 'Ac']))).toBe(true);
    expect(isStraight(parseFlop(['Kh', 'Ad', '2c']))).toBe(false);
    expect(isStraight(parseFlop(['7h', '5d', '6c']))).toBe(true);
  });

  it('counts the ace in Jack or Better', () => {
    expect(getMarket('all-faces').wins(parseFlop(['Jh', 'Ad', 'Kc']))).toBe(true);
    expect(getMarket('all-faces').wins(parseFlop(['Th', 'Ad', 'Kc']))).toBe(false);
  });

  it('lists every winning market for a flop', () => {
    const won = winningMarkets(parseFlop(['Qc', '7h', '3s']));
    expect(won).toEqual(['rainbow']);
    expect(winningMarkets(parseFlop(['Ah', 'Ad', '5h']))).toEqual(
      expect.arrayContaining(['same-color', 'has-ace', 'any-pair', 'pair-aces']),
    );
  });

  it('throws on an unknown market', () => {
    expect(() => getMarket('nope')).toThrow('Unknown market');
  });
});
