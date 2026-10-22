/** Shapes returned by the TV endpoints (see apps/server/src/modules/tv). */
export type TvKind = 'cash' | 'tournament';

export interface TvMarketRef { readonly slug: string; readonly name: string }

export interface TvHand {
  readonly handNumber: number;
  readonly status: 'betting_open' | 'betting_closed' | 'settled' | 'cancelled';
  readonly cards: string[] | null;
  readonly winningMarkets: TvMarketRef[];
  readonly bettingClosesAt: string | null;
  readonly players: number;
  readonly bets: number;
  readonly stakedCents: number;
  readonly paidOutCents: number;
  readonly winners: number;
}

export interface CashTvData {
  readonly table: {
    readonly name: string;
    readonly status: string;
    readonly clubName: string;
    readonly roomName: string | null;
    readonly joinCode: string | null;
    readonly joinUrl: string | null;
  };
  readonly hand: TvHand | null;
  readonly markets: { slug: string; name: string; picks: number; players: number }[];
  readonly recent: { handNumber: number; cards: string[] | null; winningMarkets: string[] }[];
  readonly bettingTimerSeconds: number | null;
  readonly serverNow: string;
  readonly expiresAt: string;
}

export interface TvLevelWindow {
  readonly levelNumber: number;
  readonly minBetChips: number;
  readonly maxBetChips: number;
  readonly startHand: number;
  readonly endHand: number;
}

export interface TournamentTvRow {
  readonly rank: number;
  readonly name: string;
  readonly chips: number;
  readonly status: 'playing' | 'finished';
  readonly place: number | null;
  readonly payoutCents: number;
}

export interface TournamentTvData {
  readonly tournament: { name: string; status: string; totalHands: number | null; endCondition: string };
  readonly currentHand: Pick<TvHand, 'handNumber' | 'status' | 'cards' | 'winningMarkets' | 'bettingClosesAt'> | null;
  readonly level: { current: TvLevelWindow | null; next: TvLevelWindow | null; isFinal: boolean };
  readonly prizePoolCents: number;
  readonly guaranteed: boolean;
  readonly payouts: { place: number; amountCents: number }[];
  readonly entrants: number;
  readonly playersLeft: number;
  readonly leaderboard: TournamentTvRow[];
  readonly more: number;
  readonly serverNow: string;
  readonly expiresAt: string;
}

export interface PairingResponse {
  readonly pairingId: string;
  readonly pairingCode: string;
  readonly expiresInMinutes: number;
  readonly expiresAt: string;
  readonly tvPath: string;
  readonly tvUrl: string;
}

export interface DirectLinkResponse {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly tvPath: string;
  readonly tvUrl: string;
}

export interface TvSessionInfo {
  readonly id: string;
  readonly kind: TvKind;
  readonly via: 'pairing' | 'link';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string | null;
}

export interface ClaimResponse {
  readonly displayToken: string;
  readonly expiresAt: string;
  readonly tableName?: string;
  readonly tournamentName?: string;
}
