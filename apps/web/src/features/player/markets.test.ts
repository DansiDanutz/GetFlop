import { describe, expect, it } from 'vitest';
import { MARKETS, parseFlop, winningMarkets } from '@getflop/engine';
import { blockReason, EXAMPLE_FLOPS, heatHeadline, marketsForTab, RULE_GROUPS, tablePhase } from './markets';
import type { HeatBoard, OfferedMarket, PublicHand } from './types';

const offered = (slugs: string[]): OfferedMarket[] =>
  MARKETS.filter((m) => slugs.includes(m.slug)).map((m) => ({ slug: m.slug, name: m.name, group: m.group, multiplier: m.multiplier }));

describe('marketsForTab', () => {
  const all = offered(MARKETS.filter((m) => m.enabledByDefault).map((m) => m.slug));

  it('lists the popular markets sorted by multiplier', () => {
    expect(marketsForTab(all, 'popular').map((m) => m.slug)).toEqual([
      'rainbow', 'same-color', 'has-ace', 'any-pair', 'any-flush', 'all-lows', 'straight', 'all-faces', 'pair-aces', 'trips-or-sf',
    ]);
  });

  it('groups pairs, flushes, colours, straights and specials', () => {
    expect(marketsForTab(all, 'pairs')[0]!.slug).toBe('any-pair');
    expect(marketsForTab(all, 'pairs')).toHaveLength(14);
    expect(marketsForTab(all, 'flushes').map((m) => m.slug)).toEqual(['any-flush', 'flush-hearts', 'flush-diamonds', 'flush-clubs', 'flush-spades']);
    expect(marketsForTab(all, 'colors').map((m) => m.slug)).toEqual(['rainbow', 'same-color']);
    expect(marketsForTab(all, 'straights').map((m) => m.slug)).toEqual(['straight']);
    expect(marketsForTab(all, 'specials').map((m) => m.slug)).toEqual(['has-ace', 'all-lows', 'all-faces', 'trips-or-sf']);
    expect(marketsForTab(all, 'all')).toHaveLength(all.length);
  });

  it('only shows what the table offers', () => {
    expect(marketsForTab(offered(['rainbow']), 'pairs')).toEqual([]);
  });
});

describe('rules content', () => {
  it('groups every market exactly once', () => {
    const grouped = RULE_GROUPS.flatMap((g) => g.slugs);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual(MARKETS.map((m) => m.slug).sort());
  });

  it('has example flops that really win their market', () => {
    for (const [slug, flops] of Object.entries(EXAMPLE_FLOPS)) {
      for (const flop of flops) expect(winningMarkets(parseFlop(flop)), `${slug} ${flop.join(' ')}`).toContain(slug);
    }
    expect(Object.keys(EXAMPLE_FLOPS)).toHaveLength(MARKETS.length);
  });
});

describe('blockReason', () => {
  const base = { canPlay: false, dealerId: null, userId: 'u1', playMode: 'play' as const };
  it('is null when the player can play', () => {
    expect(blockReason({ ...base, canPlay: true })).toBeNull();
  });
  it('explains why not: dealing here, watch-only, or staff', () => {
    expect(blockReason({ ...base, dealerId: 'u1' })).toBe('dealer');
    expect(blockReason({ ...base, playMode: 'watch' })).toBe('watch');
    expect(blockReason(base)).toBe('staff');
  });
});

describe('tablePhase', () => {
  const hand = (status: PublicHand['status']) => ({ status } as PublicHand);
  it('follows the live hand, then the last hand', () => {
    expect(tablePhase({ status: 'closed', currentHand: null, lastHand: null })).toBe('table_closed');
    expect(tablePhase({ status: 'open', currentHand: hand('betting_open'), lastHand: null })).toBe('open');
    expect(tablePhase({ status: 'open', currentHand: hand('betting_closed'), lastHand: null })).toBe('closed');
    expect(tablePhase({ status: 'open', currentHand: null, lastHand: hand('settled') })).toBe('settled');
    expect(tablePhase({ status: 'open', currentHand: null, lastHand: null })).toBe('waiting');
  });
  it('lets a fresher cancelled hand win over the last settled one', () => {
    expect(tablePhase({ status: 'open', currentHand: null, lastHand: hand('settled') }, true)).toBe('cancelled');
  });
});

describe('heatHeadline', () => {
  const board = (over: Partial<HeatBoard>): HeatBoard => ({ window: 50, flopsCounted: 50, markets: [], hot: [], cold: [], ...over });
  it('asks for more flops first, then waits for a full window', () => {
    expect(heatHeadline(board({ flopsCounted: 4 }))).toEqual({ state: 'few', hot: [], cold: [] });
    expect(heatHeadline(board({ flopsCounted: 30 }))).toEqual({ state: 'filling', hot: [], cold: [] });
  });
  it('is calm when every bar is inside the band, and names hot and cold markets otherwise', () => {
    expect(heatHeadline(board({})).state).toBe('calm');
    expect(heatHeadline(board({ hot: ['rainbow', 'has-ace'], cold: ['any-pair'] })))
      .toEqual({ state: 'mixed', hot: ['rainbow', 'has-ace'], cold: ['any-pair'] });
  });
});
