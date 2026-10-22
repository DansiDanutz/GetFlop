import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import type {
  CouponDraws, CouponSummary, HandStats, HeatBoard, OfferedMarket, PlaceCouponResult, PlayerTableResponse, PublicHand, TableView,
} from './types';
import type { SlipPick } from './slip';

/** React Query keys for the player feature. Every key starts with 'player'. */
export const playerKeys = {
  all: ['player'] as const,
  tables: ['player', 'tables'] as const,
  table: (id: string) => ['player', 'table', id] as const,
  stats: (id: string) => ['player', 'stats', id] as const,
  hands: (id: string) => ['player', 'hands', id] as const,
  coupons: (tableId: string, status: string) => ['player', 'coupons', tableId, status] as const,
  couponsAll: ['player', 'coupons'] as const,
  draws: (couponId: string) => ['player', 'draws', couponId] as const,
  heat: (id: string) => ['player', 'heat', id] as const,
  balance: ['player', 'balance'] as const,
  catalogue: ['player', 'catalogue'] as const,
};

const RECENT_HANDS = 10;
const LOBBY_REFRESH_MS = 30_000;

export const usePlayerTables = () => useQuery({
  queryKey: playerKeys.tables,
  queryFn: () => api.get<{ tables: TableView[] }>('/player/tables'),
  refetchInterval: LOBBY_REFRESH_MS,
});

export const usePlayerTable = (id: string) => useQuery({
  queryKey: playerKeys.table(id),
  queryFn: () => api.get<PlayerTableResponse>(`/player/table/${encodeURIComponent(id)}`),
});

export const useHandStats = (id: string) => useQuery({
  queryKey: playerKeys.stats(id),
  queryFn: () => api.get<HandStats>(`/player/table/${encodeURIComponent(id)}/stats`),
});

export const useRecentHands = (id: string) => useQuery({
  queryKey: playerKeys.hands(id),
  queryFn: () => api.get<{ hands: PublicHand[] }>(`/player/table/${encodeURIComponent(id)}/hands${qs({ limit: RECENT_HANDS })}`),
});

export const useTableCoupons = (tableId: string, status: 'live' | 'completed') => useQuery({
  queryKey: playerKeys.coupons(tableId, status),
  queryFn: () => api.get<{ coupons: CouponSummary[] }>(`/player/coupons${qs({ status, tableId })}`),
});

export const useCouponDraws = (couponId: string | null) => useQuery({
  queryKey: playerKeys.draws(couponId ?? ''),
  queryFn: () => api.get<CouponDraws>(`/player/coupon/${encodeURIComponent(couponId ?? '')}/draws`),
  enabled: Boolean(couponId),
});

export const useHeat = (id: string, enabled: boolean) => useQuery({
  queryKey: playerKeys.heat(id),
  queryFn: () => api.get<HeatBoard>(`/player/table/${encodeURIComponent(id)}/heat`),
  enabled,
});

export const useBalance = () => useQuery({
  queryKey: playerKeys.balance,
  queryFn: () => api.get<{ clubId: string; balanceCents: number }>('/player/balance'),
});

export const useCatalogue = () => useQuery({
  queryKey: playerKeys.catalogue,
  queryFn: () => api.get<{ betTypes: OfferedMarket[] }>('/tournaments/bet-types/list'),
  staleTime: 5 * 60_000,
});

export function placeCoupon(tableId: string, picks: readonly SlipPick[], rounds: number): Promise<PlaceCouponResult> {
  return api.post<PlaceCouponResult>('/player/coupon', {
    tableId, rounds, selections: picks.map((p) => ({ betTypeId: p.market, stakeCents: p.stakeCents })),
  });
}

export interface LatestSettledEntry {
  handId: string;
  handNumber: number;
  cards: string[];
  matchingSlugs: string[];
  wonCents: number;
  mine: { betId: string; market: string; stakeCents: number; payoutCents: number; status: string }[];
}

export function fetchLatestSettled(ids: readonly string[]): Promise<{ tables: Record<string, LatestSettledEntry> }> {
  return api.get(`/player/tables/latest-settled${qs({ ids: ids.join(',') })}`);
}

// ── Play again hand-off (other screens queue a finished coupon for the next table opened) ──

const PLAY_AGAIN_KEY = 'getflop_play_again';
const CONFIRMED_KEY = 'getflop_coupon_lock_ack';

export interface QueuedPlayAgain {
  readonly picks: readonly SlipPick[];
  readonly rounds: number;
}

/** Stores a finished coupon so the table screen loads it into the slip (spec 01 §5.6). */
export function queuePlayAgain(entry: QueuedPlayAgain): void {
  try { sessionStorage.setItem(PLAY_AGAIN_KEY, JSON.stringify(entry)); } catch { /* storage unavailable: nothing queued */ }
}

/** Reads and clears a queued play-again, validating its shape. */
export function takePlayAgain(): QueuedPlayAgain | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PLAY_AGAIN_KEY);
    sessionStorage.removeItem(PLAY_AGAIN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { picks?: unknown; rounds?: unknown };
    const picks = Array.isArray(parsed.picks) ? parsed.picks : [];
    const valid = picks.filter((p): p is SlipPick =>
      typeof p === 'object' && p !== null && typeof (p as SlipPick).market === 'string' && Number.isInteger((p as SlipPick).stakeCents));
    return typeof parsed.rounds === 'number' ? { picks: valid, rounds: parsed.rounds } : null;
  } catch {
    return null;
  }
}

/** Whether this device has already acknowledged "locked once placed". */
export function hasAcknowledgedLock(): boolean {
  try { return localStorage.getItem(CONFIRMED_KEY) === '1'; } catch { return false; }
}

export function acknowledgeLock(): void {
  try { localStorage.setItem(CONFIRMED_KEY, '1'); } catch { /* storage unavailable: ask again next time */ }
}
