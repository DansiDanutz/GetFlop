/** Response shapes of the player endpoints (see docs/spec/14-api-and-realtime.md §3). */

export type HandStatus = 'betting_open' | 'betting_closed' | 'settled' | 'cancelled';
export type Unit = 'points' | 'chips' | 'stars';

export interface PublicHand {
  id: string;
  handNumber: number;
  status: HandStatus;
  flop: string[] | null;
  matchingSlugs: string[];
  totalBets: number;
  winningBets: number;
  totalWageredCents: number;
  totalPaidOutCents: number;
  bettingClosesAt: string | null;
  dealtBy: string;
  createdAt: string;
  settledAt: string | null;
}

export interface OfferedMarket {
  slug: string;
  name: string;
  group: string;
  multiplier: number;
}

export interface TableLimits {
  minCents: number;
  maxCents: number;
  couponCapCents: number;
  maxRounds: number;
  marketMaxCents: Record<string, number>;
}

export interface TableView {
  id: string;
  clubId: string;
  name: string;
  game: 'nlh' | 'plo' | 'other' | string;
  photoUrl: string | null;
  featured: boolean;
  kind: 'cash' | 'tournament' | 'arena' | string;
  status: 'open' | 'closed' | string;
  isAutoDeal: boolean;
  dealerId: string | null;
  dealerName: string | null;
  unit: Unit;
  limits: TableLimits;
  tournamentId: string | null;
  lastHandNumber: number;
  offered: OfferedMarket[];
  currentHand: PublicHand | null;
  lastHand: PublicHand | null;
}

export interface PlayerTableResponse {
  table: TableView;
  balanceCents: number;
  canPlay: boolean;
}

export interface HandStats {
  hand: { id: string; handNumber: number; status: HandStatus } | null;
  players: number;
  picks: number;
  playedCents: number;
  bettingTimerSeconds: number;
}

export interface CouponPick {
  market: string;
  stakeCents: number;
  multiplier: number;
  status: string;
}

export interface CouponSummary {
  id: string;
  tableId: string;
  tableName: string;
  unit: Unit;
  status: 'live' | 'completed' | 'voided';
  rounds: number;
  roundsSettled: number;
  committedCents: number;
  wonCents: number;
  refundedCents: number;
  stillAtStakeCents: number;
  createdAt: string;
  finishedAt: string | null;
  picks: CouponPick[];
}

export interface DrawPick {
  market: string;
  stakeCents: number;
  status: 'pending' | 'won' | 'lost' | 'refunded' | 'voided';
  payoutCents: number;
}

export interface Draw {
  handNumber: number;
  status: HandStatus;
  flop: string[] | null;
  picks: DrawPick[];
}

export interface CouponDraws {
  coupon: CouponSummary;
  draws: Draw[];
}

export type HeatState = 'hot' | 'cold' | 'normal';

export interface HeatMarket {
  slug: string;
  name: string;
  hits: number;
  rate: number;
  expected: number;
  band: { low: number; high: number };
  judged: boolean;
  state: HeatState;
  hitSeq: boolean[];
}

export interface HeatBoard {
  window: number;
  flopsCounted: number;
  markets: HeatMarket[];
  hot: string[];
  cold: string[];
}

export interface SettledBet {
  betId: string;
  userId: string;
  username: string;
  betTypeSlug: string;
  amountCents: number;
  payoutCents: number;
  couponId: string;
}

export interface HandSettledEvent {
  tableId: string;
  handId: string;
  handNumber: number;
  card1: string;
  card2: string;
  card3: string;
  matchingSlugs: string[];
  winners: SettledBet[];
  losers: SettledBet[];
  isTournament: boolean;
}

export interface PlaceCouponResult {
  couponId: string;
  rounds: number;
  totalCommitmentCents: number;
  balanceCents: number;
  unit: Unit;
  isTournament: boolean;
  playsCurrentHand: boolean;
}
