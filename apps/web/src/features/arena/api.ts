import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, qs } from '../../lib/api';
import type { Refill } from './logic';

export interface ArenaSummary {
  open: boolean;
  entered: boolean;
  clubId?: string;
  tableId?: string;
  balanceCents: number;
  dealSeconds?: number;
  shopOpen?: boolean;
  refill?: Refill;
  totalFlops?: number;
}

export interface EnterResult {
  kind: 'welcome' | 'refill' | null;
  grantedCents: number;
  balanceCents: number;
  refill: Refill;
}

export interface ArenaBar {
  rank: number | null;
  weekOf: string;
  balanceCents: number;
  hidden: boolean;
  refill: Refill;
  shop: { open: boolean };
}

export interface DealClock { phase: 'open' | 'closing' | 'result' | 'asleep'; windowMs: number; remainingMs: number; endsAt: string | null }
export interface Market { slug: string; name: string; group: string; multiplier: number }
export interface Hand {
  id: string; handNumber: number; status: string; flop: string[] | null; matchingSlugs: string[];
  bettingClosesAt: string | null; settledAt: string | null;
}

export interface ArenaTable {
  id: string; name: string; status: string; unit: 'stars'; isAutoDeal: boolean;
  limits: { minCents: number; maxRounds: number };
  offered: Market[];
  currentHand: Hand | null;
  lastHand: Hand | null;
  awake: boolean;
  dealClock: DealClock;
  dealSeconds: number;
}

/** A table answer stamped with when it arrived, so the ring does not depend on the device clock. */
export interface Stamped<T> { data: T; receivedAt: number }

export interface SitResult { table: ArenaTable; balanceCents: number; canPlay: boolean }

export interface CouponPick { market: string; stakeCents: number; multiplier: number; status: string }
export interface Coupon {
  id: string; status: string; rounds: number; roundsSettled: number; committedCents: number; wonCents: number;
  stillAtStakeCents: number; picks: CouponPick[];
}

export type Title = 'champion' | 'veteran' | 'sharpshooter';
export interface BoardEntry { rank: number; username: string | null; hidden: boolean; flops: number; netCents: number; me: boolean; titles: Title[] }
export type BoardPeriod = 'week' | 'month' | 'all';
export interface Board {
  period: BoardPeriod; weekOf: string; closesAt: string | null; players: number;
  podium: BoardEntry[]; top: BoardEntry[]; me: BoardEntry | null; meHidden: boolean; hasPlayed: boolean;
  biggestHit: { username: string | null; hidden: boolean; multiplier: number; starsCents: number } | null;
}

export interface Badge {
  code: string; group: string; earned: boolean; earnedAt: string | null; times: number;
  progress: { current: number; target: number; best?: number } | null;
}
export interface Medals { badges: Badge[]; earnedCount: number; totalCount: number }

export interface Pack {
  id: string; starsCents: number; priceCents: number; totalCents: number; bonusPct: number | null;
  available: boolean; unavailableReason: 'shop_closed' | 'cap_day' | 'cap_month' | 'checkout_open' | null;
}
export interface Shop {
  open: boolean; cardPayments: boolean; devPayments: boolean; vatPct: number;
  capDayCents: number; capMonthCents: number; leftDayCents: number; leftMonthCents: number;
  spentDayCents: number; spentMonthCents: number; openOrderId: string | null; packs: Pack[];
}

export const arenaKeys = {
  all: ['arena'] as const,
  summary: ['arena', 'summary'] as const,
  bar: ['arena', 'bar'] as const,
  tables: ['arena', 'tables'] as const,
  table: (id: string) => ['arena', 'table', id] as const,
  coupons: ['arena', 'coupons'] as const,
  board: (p: BoardPeriod) => ['arena', 'board', p] as const,
  medals: ['arena', 'medals'] as const,
  packs: ['arena', 'packs'] as const,
};

export const arenaApi = {
  summary: () => api.get<ArenaSummary>('/arena/summary'),
  enter: () => api.post<EnterResult>('/arena/enter'),
  bar: () => api.get<ArenaBar>('/arena/bar'),
  tables: async (): Promise<Stamped<{ tables: ArenaTable[]; dealSeconds: number }>> =>
    ({ data: await api.get('/arena/tables'), receivedAt: Date.now() }),
  sit: async (id: string): Promise<Stamped<SitResult>> => ({ data: await api.post(`/arena/table/${id}/sit`), receivedAt: Date.now() }),
  coupons: () => api.get<{ coupons: Coupon[] }>(`/arena/coupons${qs({ status: 'live' })}`),
  placeCoupon: (tableId: string, markets: string[], stakeCents: number, rounds: number) =>
    api.post<{ couponId: string; totalCommitmentCents: number; balanceCents: number; rounds: number }>('/arena/coupon', {
      tableId, rounds, selections: markets.map((market) => ({ market, stakeCents })),
    }),
  board: (period: BoardPeriod) => api.get<Board>(`/arena/board${qs({ period })}`),
  setHidden: (hidden: boolean) => api.post<{ hidden: boolean }>('/arena/board-visibility', { hidden }),
  medals: () => api.get<Medals>('/arena/medals'),
  packs: () => api.get<Shop>('/arena/packs'),
  checkout: (packId: string, locale: string) => api.post<{ url: string; orderId: string }>('/arena/checkout', { packId, consent: true, locale }),
  cancelOrder: (id: string) => api.post<{ status: string }>(`/arena/orders/${id}/cancel`),
  simulatePaid: (id: string) => api.post<{ status: string; starsCents: number; balanceCents: number }>(`/arena/orders/${id}/simulate-paid`),
};

export const useArenaSummary = () => useQuery({ queryKey: arenaKeys.summary, queryFn: arenaApi.summary });
export const useArenaBar = (enabled = true) => useQuery({ queryKey: arenaKeys.bar, queryFn: arenaApi.bar, enabled });

/** Refreshes every Arena query after a balance or hand change. */
export function useArenaRefresh(): () => void {
  const qc = useQueryClient();
  return useCallback(() => { void qc.invalidateQueries({ queryKey: arenaKeys.all }); }, [qc]);
}
