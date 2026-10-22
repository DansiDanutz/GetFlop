import { describe, expect, it } from 'vitest';
import { levelProgress, rankLeaderboard } from './levels.js';

const LEVELS = [
  { levelNumber: 1, minBetChips: 100, maxBetChips: -1, endHand: 10 },
  { levelNumber: 2, minBetChips: 200, maxBetChips: -1, endHand: 20 },
  { levelNumber: 3, minBetChips: 400, maxBetChips: 800, endHand: 30 },
];

describe('levelProgress', () => {
  it('returns level 1 before the first hand', () => {
    expect(levelProgress(LEVELS, 0)).toMatchObject({
      current: { levelNumber: 1, startHand: 1, endHand: 10 }, next: { levelNumber: 2, startHand: 11 }, isFinal: false,
    });
  });

  it('switches level on the hand after the end hand', () => {
    expect(levelProgress(LEVELS, 10).current?.levelNumber).toBe(1);
    expect(levelProgress(LEVELS, 11).current).toMatchObject({ levelNumber: 2, startHand: 11, endHand: 20 });
  });

  it('marks the final level and stays on it past its end', () => {
    expect(levelProgress(LEVELS, 25)).toMatchObject({ current: { levelNumber: 3 }, next: null, isFinal: true });
    expect(levelProgress(LEVELS, 99).current?.levelNumber).toBe(3);
  });

  it('sorts unsorted levels and handles an empty list', () => {
    expect(levelProgress([...LEVELS].reverse(), 12).current?.levelNumber).toBe(2);
    expect(levelProgress([], 5)).toEqual({ current: null, next: null, isFinal: false });
  });
});

describe('rankLeaderboard', () => {
  it('lists playing players by chips, then finished players by place', () => {
    const board = rankLeaderboard([
      { name: 'Bo', chips: 0, status: 'finished', place: 4, payoutCents: 0 },
      { name: 'Al', chips: 500, status: 'playing', place: null, payoutCents: 0 },
      { name: 'Cy', chips: 900, status: 'playing', place: null, payoutCents: 0 },
      { name: 'Di', chips: 0, status: 'finished', place: 3, payoutCents: 100 },
    ]);
    expect(board.map((r) => [r.name, r.rank])).toEqual([['Cy', 1], ['Al', 2], ['Di', 3], ['Bo', 4]]);
  });
});
