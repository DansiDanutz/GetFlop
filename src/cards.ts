// Cards are small integers 0..51: rank = 2 + (card >> 2) (2..14, 14 = Ace), suit = card & 3.
// Text form is two characters, e.g. "Ah", "Td", "7c".

export type Card = number;
export type Flop = [Card, Card, Card];

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs'; // clubs, diamonds, hearts, spades
export const RED_SUITS = new Set([1, 2]);

export const rankOf = (c: Card): number => 2 + (c >> 2);
export const suitOf = (c: Card): number => c & 3;
export const isRed = (c: Card): boolean => RED_SUITS.has(suitOf(c));

export function parseCard(text: string): Card {
  if (typeof text !== 'string' || text.length !== 2) throw new Error(`bad card "${text}"`);
  const r = RANKS.indexOf(text[0].toUpperCase());
  const s = SUITS.indexOf(text[1].toLowerCase());
  if (r < 0 || s < 0) throw new Error(`bad card "${text}"`);
  return (r << 2) | s;
}

export const formatCard = (c: Card): string => RANKS[c >> 2] + SUITS[c & 3];
export const CARD_CODES: string[] = Array.from({ length: 52 }, (_, c) => formatCard(c));

export function parseFlop(cards: unknown): Flop {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('a flop is exactly 3 cards');
  const flop = cards.map((c) => parseCard(String(c))) as Flop;
  if (new Set(flop).size !== 3) throw new Error('flop cards must be different');
  return flop;
}

// Every unordered 3-card combination of a 52-card deck: C(52,3) = 22,100.
// From a bettor's point of view the hole cards are unknown, so each flop is equally likely.
export const ALL_FLOPS: Flop[] = (() => {
  const out: Flop[] = [];
  for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) out.push([a, b, c]);
  return out;
})();

export function flopIndex(flop: Flop): number {
  const [a, b, c] = [...flop].sort((x, y) => x - y);
  return FLOP_INDEX.get(a * 2704 + b * 52 + c)!;
}
const FLOP_INDEX = new Map(ALL_FLOPS.map(([a, b, c], i) => [a * 2704 + b * 52 + c, i]));
