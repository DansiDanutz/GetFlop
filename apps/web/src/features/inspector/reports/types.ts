import type { MarketStat } from '../model/reports';

export interface LiveWindow { kind: 'session' | 'today'; number: number | null; since: string }

export interface LiveCouponRow {
  couponId: string; userId: string; player: string; tableId: string; tableName: string;
  picks: { market: string; stakeCents: number; multiplier: number; status: string }[];
  rounds: number; roundsSettled: number; outcome: 'in_progress' | 'won' | 'lost' | 'voided';
  committedCents: number; wonCents: number; refundedCents: number; lostCents: number; createdAt: string; isBig: boolean;
}

export interface LiveBets { window: LiveWindow; totals: { stakedCents: number; paidCents: number; clubCents: number }; bigThresholdCents: number; rows: LiveCouponRow[] }

export interface LivePointsRow {
  id: string; type: 'send_out' | 'claim_back' | 'request' | 'return'; amountCents: number; userId: string | null; player: string;
  actorId: string | null; actor: string | null; byMe: boolean; byPlayer: boolean; createdAt: string;
}

export interface LivePoints { window: LiveWindow; totals: { givenCents: number; takenCents: number; netCents: number }; staff: { id: string; name: string }[]; rows: LivePointsRow[] }

export interface ReportsIndex { segments: string[]; bigThresholdCents: number; tz: string; tables: { id: string; name: string; kind: string; status: string }[] }

export interface HandRow {
  id: string; handNumber: number; tableId: string; tableName: string; kind: 'cash' | 'tournament'; unit: string;
  flop: string[] | null; bets: number; winningBets: number; playedCents: number; paidCents: number; holdCents: number;
  dealtBy: string; settledAt: string;
}

export interface HandsResult { hands: HandRow[]; truncated: boolean; limit: number }

export interface HandDetail {
  hand: { id: string; handNumber: number; status: string; flop: string[] | null; playedCents: number; paidCents: number; settledAt: string | null };
  table: { id: string; name: string; kind: string };
  dealtBy: { kind: 'auto' | 'dealer'; name: string | null };
  isTournament: boolean;
  unit: string;
  players: { userId: string; name: string; playedCents: number; wonCents: number;
    picks: { betId: string; market: string; stakeCents: number; multiplier: number; status: 'won' | 'lost' | 'refunded' | 'open'; payoutCents: number }[] }[];
}

export interface Line { picks: number; hands: number; players: number; handleCents: number; paidCents: number; resultCents: number; holdPct: number | null; theoHoldPct: number | null }

export interface Summary {
  kpis: { hands: number; playedCents: number; paidCents: number; resultCents: number; holdPct: number | null;
    tournaments: { entries: number; collectedCents: number; prizesCents: number } };
  byRoom: (Line & { roomId: string | null; name: string | null })[];
  byTable: (Line & { tableId: string; name: string; idle: boolean })[];
  byMarket: MarketStat[];
  byPlayer: PlayerLine[];
}

export interface PlayerLine { userId: string; name: string; picks: number; playedCents: number; wonCents: number; resultCents: number; inCents: number; outCents: number; balanceCents: number }

export interface ShiftReport {
  points: { inCents: number; outCents: number; netCents: number };
  play: { hands: number; picks: number; playedCents: number; paidCents: number; holdCents: number; holdPct: number | null };
  tournaments: { entries: number; buyinsCents: number; rebuysCents: number; addonsCents: number; prizesCents: number; resultCents: number };
  byMarket: { ring: MarketStat[]; chips: MarketStat[] };
  byRoom: Summary['byRoom'];
  byTable: Summary['byTable'];
  byPlayer: PlayerLine[];
}

export interface ClubReport {
  results: { flops: number; playedCents: number; paidCents: number; resultCents: number; holdPct: number | null; ridingCents: number; ridingCoupons: number };
  players: { active: number; new: number; returning: number; top: { userId: string; name: string; picks: number; playedCents: number; resultCents: number }[] };
  points: { issuedCents: number; sentCents: number; returnedCents: number; intoCouponsCents: number; wonCents: number; refundedCents: number;
    tournamentEntriesCents: number; tournamentPrizesCents: number; playersHoldCents: number; clubHoldsCents: number };
  diamonds: { measuredPlayD: number; pilot: boolean };
}

export interface SessionView {
  id: string; number: number; openedAt: string; closedAt: string | null; closedReason: string | null; openedBy: string | null; closedBy: string | null;
  summary: { hands: number; players: number; handleCents: number; resultCents: number } | null;
}

export interface Analytics {
  scope: { kind: 'session' | 'range' | 'last24h'; sessionNumber: number | null };
  handleCents: number; ggrCents: number; holdPct: number | null; theoHoldPct: number | null; hands: number; picks: number; players: number;
  byMarket: MarketStat[];
  byDealer: (Line & { dealerId: string | null; name: string | null; auto: boolean })[];
  byTable: (Line & { tableId: string; name: string })[];
  notRecorded: number;
  drift: { ok: true; checked: number; driftingCount: number; worstDriftCents: number } | { ok: false };
}
