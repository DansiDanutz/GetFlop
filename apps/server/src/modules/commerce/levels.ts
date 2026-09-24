/** Club Levels (tour pricing). Prices in Diamonds per 30 days; 100 D = €1. */
export interface ClubLevel {
  readonly code: string;
  readonly name: string;
  readonly priceDiamonds: number;
  readonly members: number;
  readonly ringGames: number;
  readonly tournaments: number;
  readonly rooms: number;
}

export const CLUB_LEVELS: readonly ClubLevel[] = [
  { code: 'starter', name: 'Starter', priceDiamonds: 0, members: 30, ringGames: 1, tournaments: 0, rooms: 1 },
  { code: 'club100', name: 'Club 100', priceDiamonds: 5_000, members: 100, ringGames: 2, tournaments: 1, rooms: 1 },
  { code: 'club500', name: 'Club 500', priceDiamonds: 10_000, members: 500, ringGames: 5, tournaments: 2, rooms: 1 },
  { code: 'club1k', name: 'Club 1K', priceDiamonds: 20_000, members: 1_000, ringGames: 8, tournaments: 3, rooms: 1 },
  { code: 'club2_5k', name: 'Club 2.5K', priceDiamonds: 35_000, members: 2_500, ringGames: 12, tournaments: 5, rooms: 1 },
  { code: 'club5k', name: 'Club 5K', priceDiamonds: 50_000, members: 5_000, ringGames: 20, tournaments: 8, rooms: 1 },
];

export function levelOf(code: string): ClubLevel {
  return CLUB_LEVELS.find((l) => l.code === code) ?? CLUB_LEVELS[0]!;
}

export function nextLevel(code: string): ClubLevel | null {
  const i = CLUB_LEVELS.findIndex((l) => l.code === code);
  return CLUB_LEVELS[i + 1] ?? null;
}
