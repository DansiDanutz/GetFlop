export const SUITS = ['s', 'h', 'd', 'c'] as const;
export type Suit = (typeof SUITS)[number];

/** Ranks 2..14, where 11=J, 12=Q, 13=K, 14=A. */
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  readonly rank: Rank;
  readonly suit: Suit;
}

export type Flop = readonly [Card, Card, Card];

const RANK_CHARS: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: 'T', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
const CHAR_TO_RANK: Record<string, Rank> = Object.fromEntries(
  Object.entries(RANK_CHARS).map(([rank, ch]) => [ch, Number(rank) as Rank]),
);

export const RED_SUITS: ReadonlySet<Suit> = new Set(['h', 'd']);

export function cardToString(card: Card): string {
  return `${RANK_CHARS[card.rank]}${card.suit}`;
}

/** Parses "Qh", "Tc", "10c", "As". Throws on invalid input. */
export function parseCard(input: string): Card {
  const text = input.trim();
  const suit = text.slice(-1).toLowerCase();
  const rankText = text.slice(0, -1).toUpperCase();
  const rank = rankText === '10' ? 10 : CHAR_TO_RANK[rankText];
  if (!rank || !(SUITS as readonly string[]).includes(suit)) {
    throw new Error(`Invalid card: "${input}"`);
  }
  return { rank, suit: suit as Suit };
}

/** Validates and builds a flop of three distinct cards. */
export function parseFlop(inputs: readonly string[]): Flop {
  if (inputs.length !== 3) throw new Error('A flop has exactly 3 cards');
  const cards = inputs.map(parseCard);
  const keys = new Set(cards.map(cardToString));
  if (keys.size !== 3) throw new Error('Flop cards must be distinct');
  return [cards[0]!, cards[1]!, cards[2]!];
}

export function fullDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

/** Every unordered 3-card flop from a 52-card deck (22,100 of them). */
export function allFlops(): Flop[] {
  const deck = fullDeck();
  const flops: Flop[] = [];
  for (let i = 0; i < deck.length; i++)
    for (let j = i + 1; j < deck.length; j++)
      for (let k = j + 1; k < deck.length; k++) flops.push([deck[i]!, deck[j]!, deck[k]!]);
  return flops;
}

/** Deals a random flop using the supplied RNG (defaults to crypto). */
export function randomFlop(rng: () => number = cryptoRandom): Flop {
  const deck = fullDeck();
  for (let i = 0; i < 3; i++) {
    const j = i + Math.floor(rng() * (deck.length - i));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return [deck[0]!, deck[1]!, deck[2]!];
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}
