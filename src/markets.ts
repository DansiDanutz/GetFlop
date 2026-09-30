// The bet menu. Each market is a yes/no question about the flop. Probabilities are exact:
// every market is evaluated against all 22,100 possible flops once at startup, and the
// resulting win-sets are reused for pricing, exposure control and settlement.

import { ALL_FLOPS, type Flop, isRed, rankOf, suitOf } from './cards.ts';

export type MarketDef = {
  id: string;
  group: 'suits' | 'colour' | 'ranks' | 'shape' | 'cards';
  name: string;
  test: (flop: Flop) => boolean;
};

const suitCount = (f: Flop) => new Set(f.map(suitOf)).size;
const rankCount = (f: Flop) => new Set(f.map(rankOf)).size;
const ranks = (f: Flop) => f.map(rankOf);

function isStraight(f: Flop): boolean {
  if (rankCount(f) !== 3) return false;
  const r = ranks(f).sort((a, b) => a - b);
  if (r[2] - r[0] === 2) return true;
  return r[0] === 2 && r[1] === 3 && r[2] === 14; // A-2-3, ace plays low
}

export const MARKET_DEFS: MarketDef[] = [
  { id: 'RAINBOW', group: 'suits', name: 'Rainbow (3 different suits)', test: (f) => suitCount(f) === 3 },
  { id: 'TWO_TONE', group: 'suits', name: 'Two-tone (exactly 2 suits)', test: (f) => suitCount(f) === 2 },
  { id: 'MONOTONE', group: 'suits', name: 'Monotone (all one suit)', test: (f) => suitCount(f) === 1 },
  { id: 'ALL_RED', group: 'colour', name: 'All red', test: (f) => f.every(isRed) },
  { id: 'ALL_BLACK', group: 'colour', name: 'All black', test: (f) => !f.some(isRed) },
  { id: 'NO_PAIR', group: 'ranks', name: 'Three different ranks', test: (f) => rankCount(f) === 3 },
  { id: 'PAIRED', group: 'ranks', name: 'Paired board (exactly a pair)', test: (f) => rankCount(f) === 2 },
  { id: 'TRIPS', group: 'ranks', name: 'Trips (three of a kind)', test: (f) => rankCount(f) === 1 },
  { id: 'STRAIGHT', group: 'shape', name: 'Three in a row (e.g. 7-8-9)', test: isStraight },
  { id: 'STRAIGHT_FLUSH', group: 'shape', name: 'Three in a row, same suit', test: (f) => isStraight(f) && suitCount(f) === 1 },
  { id: 'HAS_ACE', group: 'cards', name: 'At least one Ace', test: (f) => ranks(f).includes(14) },
  { id: 'HAS_FACE', group: 'cards', name: 'At least one J, Q or K', test: (f) => ranks(f).some((r) => r >= 11 && r <= 13) },
  { id: 'ALL_LOW', group: 'cards', name: 'All cards 9 or lower', test: (f) => ranks(f).every((r) => r <= 9) },
  { id: 'ALL_BROADWAY', group: 'cards', name: 'All cards 10 or higher', test: (f) => ranks(f).every((r) => r >= 10) },
];

export type Market = {
  id: string;
  group: MarketDef['group'];
  name: string;
  winningFlops: number; // out of 22,100
  probability: number;
  wins: Uint8Array; // wins[flopIndex] === 1 when the market wins on that flop
};

export const TOTAL_FLOPS = ALL_FLOPS.length;

export const MARKETS: Map<string, Market> = new Map(
  MARKET_DEFS.map((d) => {
    const wins = new Uint8Array(TOTAL_FLOPS);
    let n = 0;
    ALL_FLOPS.forEach((f, i) => {
      if (d.test(f)) { wins[i] = 1; n++; }
    });
    return [d.id, { id: d.id, group: d.group, name: d.name, winningFlops: n, probability: n / TOTAL_FLOPS, wins }];
  }),
);

// Decimal odds x100 (e.g. 250 = 2.50, stake included), rounded down to the cent so the
// house margin is never below the configured one. Markets that cannot pay at least 1.01
// after margin are not offered.
export function priceX100(market: Market, marginBps: number): number | null {
  const fair = TOTAL_FLOPS / market.winningFlops;
  const odds = Math.floor(((fair * (10_000 - marginBps)) / 10_000) * 100 + 1e-9);
  return odds >= 101 ? odds : null;
}

export function payoutFor(stake: number, oddsX100: number): number {
  return Math.floor((stake * oddsX100) / 100);
}

export function priceList(marginBps: number) {
  const out = [];
  for (const m of MARKETS.values()) {
    const oddsX100 = priceX100(m, marginBps);
    if (oddsX100 === null) continue;
    out.push({
      id: m.id,
      group: m.group,
      name: m.name,
      probability: m.probability,
      oddsX100,
      houseEdge: 1 - (m.probability * oddsX100) / 100,
    });
  }
  return out;
}
