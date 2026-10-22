import { describe, expect, it } from 'vitest';
import { AppError } from '../../http/errors.js';
import {
  assignPrizes, cannotMeetParticipation, DEFAULT_LEVELS, drawsLeft, exposureCap, lastLateRegHand, levelForHand,
  parsePayouts, participation, placeShares, prizePoolCents, rankEntries, requiredHands, resolveConfig,
  type TournamentInput,
} from './rules.js';

const MARKETS = new Set(['rainbow', 'same-color', 'has-ace', 'any-pair', 'any-flush']);
const base: TournamentInput = { name: 'Friday Freezeout', autoDealSeconds: 20, levels: DEFAULT_LEVELS };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  return 'ok';
}
const code = (input: TournamentInput) => codeOf(() => resolveConfig(input, MARKETS));

describe('wizard validation', () => {
  it('applies the documented defaults', () => {
    const cfg = resolveConfig(base, MARKETS);
    expect(cfg).toMatchObject({
      buyInCents: 500, feeCents: 50, startingStack: 1_000_000, minActionPct: 50, lateRegEndHand: 10,
      rebuyEndHand: 30, addonEndHand: 31, payoutStructure: [50, 30, 20], endCondition: 'hands', endValue: 50,
      prizePoolType: 'progressive', markets: [...MARKETS], autoStart: false,
    });
  });

  it('requires a name and levels', () => {
    expect(code({ ...base, name: '  ' })).toBe('trm.create_missing');
    expect(code({ ...base, levels: undefined })).toBe('trm.create_missing');
    expect(code({ ...base, levels: [] })).toBe('trm.levels_required');
    expect(code({ ...base, name: 'Bad <b>' })).toBe('trm.name_damaged');
    expect(code({ ...base, name: 'Broken �' })).toBe('trm.name_damaged');
  });

  it('requires exactly one of a dealer or auto-deal', () => {
    expect(code({ ...base, autoDealSeconds: null })).toBe('trm.dealer_or_auto');
    expect(code({ ...base, dealerId: 'u1' })).toBe('trm.dealer_or_auto');
    expect(code({ ...base, autoDealSeconds: 3 })).toBe('trm.dealer_or_auto');
    expect(code({ ...base, autoDealSeconds: null, dealerId: 'u1' })).toBe('ok');
  });

  it('checks the start time', () => {
    expect(code({ ...base, scheduledAt: 'not a date' })).toBe('trm.scheduled_invalid');
    expect(code({ ...base, autoStart: true })).toBe('trm.autostart_needs_time');
    expect(code({ ...base, autoStart: true, scheduledAt: '2026-09-25T20:00:00Z' })).toBe('ok');
  });

  it('validates the level table', () => {
    const lv = (over: object, i = 1) => DEFAULT_LEVELS.map((l, k) => (k === i ? { ...l, ...over } : l));
    expect(code({ ...base, levels: lv({ levelNumber: 3 }) })).toBe('trm.levels_order');
    expect(code({ ...base, levels: lv({ endHand: 0 }) })).toBe('trm.level_end_invalid');
    expect(code({ ...base, levels: lv({ endHand: 10 }) })).toBe('trm.level_end_order');
    expect(code({ ...base, levels: lv({ minBetChips: 0 }) })).toBe('trm.level_min_invalid');
    expect(code({ ...base, levels: lv({ minBetChips: 1.5 }) })).toBe('trm.level_min_invalid');
    expect(code({ ...base, levels: lv({ maxBetChips: 100 }) })).toBe('trm.level_max_below');
    expect(code({ ...base, endValue: 60 })).toBe('trm.levels_short');
    expect(code({ ...base, endCondition: 'manual' })).toBe('ok');
  });

  it('checks participation and late registration', () => {
    expect(code({ ...base, minActionPct: 101 })).toBe('trm.min_action_invalid');
    expect(code({ ...base, minActionPct: 12.5 })).toBe('trm.min_action_invalid');
    expect(code({ ...base, lateRegEndHand: 51 })).toBe('trm.latereg_after_end');
    // 50% of 50 hands = 25 needed, so late registration must close by hand 26.
    expect(lastLateRegHand(50, 50)).toBe(26);
    expect(code({ ...base, lateRegEndHand: 26 })).toBe('ok');
    expect(code({ ...base, lateRegEndHand: 27 })).toBe('trm.latereg_too_late');
    expect(code({ ...base, lateRegEndHand: 27, allowLateRegistration: false })).toBe('ok');
    expect(code({ ...base, lateRegEndHand: 40, minActionPct: 0 })).toBe('ok');
  });

  it('checks the add-on window', () => {
    expect(code({ ...base, allowAddons: true, rebuyEndHand: 30, addonEndHand: 29 })).toBe('trm.addon_before_open');
    expect(code({ ...base, allowAddons: true, rebuyEndHand: 50, addonEndHand: 51 })).toBe('trm.addon_after_end');
    expect(code({ ...base, allowAddons: true })).toBe('ok');
  });

  it('checks payouts', () => {
    expect(code({ ...base, payoutStructure: [] })).toBe('trm.payouts_empty');
    expect(code({ ...base, payoutStructure: ['50', 'x'] })).toBe('trm.payouts_not_numbers');
    expect(code({ ...base, payoutStructure: [50, 30] })).toBe('trm.payouts_sum');
    expect(parsePayouts('60, 25, 15')).toEqual([60, 25, 15]);
    expect(parsePayouts([33.33, 33.33, 33.34])).toEqual([33.33, 33.33, 33.34]);
  });

  it('rejects unknown markets', () => {
    expect(code({ ...base, allowedBetTypeIds: ['rainbow', 'nope'] })).toBe('table.market_unknown');
  });
});

describe('levels and draws', () => {
  it('finds the level for a hand', () => {
    expect(levelForHand(DEFAULT_LEVELS, 1).levelNumber).toBe(1);
    expect(levelForHand(DEFAULT_LEVELS, 10).levelNumber).toBe(1);
    expect(levelForHand(DEFAULT_LEVELS, 11).levelNumber).toBe(2);
    expect(levelForHand(DEFAULT_LEVELS, 99).levelNumber).toBe(5);
  });

  it('never lets a coupon outlive its level or the tournament', () => {
    expect(drawsLeft(DEFAULT_LEVELS, 50, 1)).toBe(10);
    expect(drawsLeft(DEFAULT_LEVELS, 50, 8)).toBe(3);
    expect(drawsLeft(DEFAULT_LEVELS, 45, 44)).toBe(2);
    expect(drawsLeft(DEFAULT_LEVELS, 50, 51)).toBe(0);
  });

  it('caps exposure at half the stack but always allows one minimum pick', () => {
    expect(exposureCap(10_000, 100)).toBe(5_000);
    expect(exposureCap(150, 100)).toBe(100);
    expect(exposureCap(50, 100)).toBe(50);
  });
});

describe('participation', () => {
  it('computes requirement, spare hands and status', () => {
    expect(requiredHands(50, 50)).toBe(25);
    expect(requiredHands(33, 10)).toBe(4);
    const good = participation({ minActionPct: 50, totalHands: 50, handsPlayed: 10, done: 10, dealt: 10 });
    expect(good).toMatchObject({ required: 25, remaining: 40, more: 15, spare: 25, vpipPct: 100, status: 'good' });
    const last = participation({ minActionPct: 50, totalHands: 50, handsPlayed: 30, done: 5, dealt: 30 });
    expect(last).toMatchObject({ more: 20, spare: 0, status: 'last_chance' });
    expect(participation({ minActionPct: 50, totalHands: 50, handsPlayed: 31, done: 5, dealt: 31 }).status).toBe('out');
    expect(participation({ minActionPct: 50, totalHands: 50, handsPlayed: 10, done: 4, dealt: 10 }).status).toBe('bad');
    expect(participation({ minActionPct: 50, totalHands: 50, handsPlayed: 10, done: 5, dealt: 9 }).status).toBe('warn');
    expect(participation({ minActionPct: 0, totalHands: 50, handsPlayed: 10, done: 0, dealt: 10 }).status).toBe('off');
  });

  it('eliminates only when the requirement is out of reach', () => {
    expect(cannotMeetParticipation({ minActionPct: 50, totalHands: 50, handsPlayed: 30, done: 5 })).toBe(false);
    expect(cannotMeetParticipation({ minActionPct: 50, totalHands: 50, handsPlayed: 31, done: 5 })).toBe(true);
    expect(cannotMeetParticipation({ minActionPct: 0, totalHands: 50, handsPlayed: 50, done: 0 })).toBe(false);
  });
});

describe('standings and prizes', () => {
  it('ranks players in, then participation outs, then busts (later bust first)', () => {
    const ranked = rankEntries([
      { id: 'bust-early', status: 'busted', chips: 0, outAtHand: 3 },
      { id: 'a', status: 'active', chips: 500, outAtHand: null },
      { id: 'lazy', status: 'eliminated', chips: 9_000, outAtHand: 20 },
      { id: 'b', status: 'active', chips: 700, outAtHand: null },
      { id: 'bust-late', status: 'busted', chips: 0, outAtHand: 9 },
    ]);
    expect(ranked.map((r) => r.entry.id)).toEqual(['b', 'a', 'lazy', 'bust-late', 'bust-early']);
    expect(ranked.map((r) => r.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it('ties equal stacks on the same position', () => {
    const ranked = rankEntries([
      { id: 'a', status: 'active', chips: 500, outAtHand: null },
      { id: 'b', status: 'active', chips: 500, outAtHand: null },
      { id: 'c', status: 'active', chips: 100, outAtHand: null },
    ]);
    expect(ranked.map((r) => r.position)).toEqual([1, 1, 3]);
  });

  it('computes the pool', () => {
    expect(prizePoolCents('progressive', 0, 1_500)).toBe(1_500);
    expect(prizePoolCents('guaranteed', 5_000, 1_500)).toBe(5_000);
    expect(prizePoolCents('guaranteed', 5_000, 7_000)).toBe(7_000);
  });

  it('floors each share and gives the remainder to 1st', () => {
    expect(placeShares(1_001, [50, 30, 20])).toEqual([501, 300, 200]);
    expect(placeShares(100, [33.33, 33.33, 33.34])).toEqual([34, 33, 33]);
  });

  it('splits tied places and leaves unfilled places unpaid', () => {
    const shares = placeShares(1_000, [50, 30, 20]);
    expect(assignPrizes([{ tieKey: 'x' }, { tieKey: 'x' }, { tieKey: 'y' }], shares)).toEqual([400, 400, 200]);
    expect(assignPrizes([{ tieKey: 'x' }, { tieKey: 'y' }], shares)).toEqual([500, 300]);
    expect(assignPrizes([{ tieKey: 'a' }, { tieKey: 'b' }, { tieKey: 'c' }, { tieKey: 'd' }], shares)).toEqual([500, 300, 200, 0]);
    expect(assignPrizes([{ tieKey: 'a' }, { tieKey: 'b' }, { tieKey: 'b' }], placeShares(1_001, [50, 30, 20]))).toEqual([501, 250, 250]);
  });
});
