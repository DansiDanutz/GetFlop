import { describe, expect, it } from 'vitest';
import { cardToString, fullDeck, parseCard, parseFlop, randomFlop } from './cards.js';

describe('cards', () => {
  it('parses and prints cards', () => {
    expect(parseCard('Qh')).toEqual({ rank: 12, suit: 'h' });
    expect(parseCard('10c')).toEqual({ rank: 10, suit: 'c' });
    expect(cardToString(parseCard('as'))).toBe('As');
  });

  it('rejects invalid cards', () => {
    expect(() => parseCard('1x')).toThrow('Invalid card');
    expect(() => parseCard('Zh')).toThrow('Invalid card');
  });

  it('requires three distinct cards in a flop', () => {
    expect(() => parseFlop(['Qh', 'Qh', '2c'])).toThrow('distinct');
    expect(() => parseFlop(['Qh', '2c'])).toThrow('exactly 3');
  });

  it('builds a 52-card deck', () => {
    expect(new Set(fullDeck().map(cardToString)).size).toBe(52);
  });

  it('deals three distinct random cards', () => {
    for (let i = 0; i < 200; i++) {
      expect(new Set(randomFlop().map(cardToString)).size).toBe(3);
    }
  });
});
