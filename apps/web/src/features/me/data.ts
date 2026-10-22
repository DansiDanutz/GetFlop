import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../../lib/api';
import { hasKey, t } from '../../i18n/i18n';
import type { RequestLists } from './amounts';

/** Response shapes of the endpoints this feature uses (server: modules/me, auth, points). */

export interface CouponPick { market: string; stakeCents: number; multiplier: number; status: string }

export interface Coupon {
  id: string;
  tableId: string;
  tableName: string;
  unit: string;
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

export type GameState = 'picks_open' | 'picks_closed' | 'waiting' | 'table_closed';

export interface Game {
  tableId: string;
  tableName: string;
  kind: string;
  unit: string;
  state: GameState;
  handNumber: number;
  tournamentId: string | null;
  liveCoupons: number;
  committedCents: number;
  wonCents: number;
  stillAtStakeCents: number;
}

export interface MyGames {
  games: Game[];
  live: Coupon[];
  recent: Coupon[];
  totals: { committedCents: number; wonCents: number; stillAtStakeCents: number; liveCoupons: number };
}

export interface DrawPick { market: string; stakeCents: number; status: string; payoutCents: number }
export interface Draw { handNumber: number; status: string; flop: string[] | null; picks: DrawPick[] }
export interface CouponDraws { coupon: Coupon; draws: Draw[] }

export interface HistoryPick {
  id: string; couponId: string; tableId: string; tableName: string; handNumber: number; market: string;
  stakeCents: number; multiplier: number; status: 'won' | 'lost'; payoutCents: number; flop: string[] | null; settledAt: string | null;
}

export interface Movement {
  id: string; kind: string; label: string; amountCents: number; balanceAfterCents: number | null;
  byPlayer: boolean; createdAt: string;
}

export interface History {
  coupons: Coupon[];
  bets: HistoryPick[];
  transactions: Movement[];
  summary: { committedCents: number; wonCents: number; netTodayCents: number; ridingCents: number };
}

export interface Identity {
  email: string | null;
  emailVerified: boolean;
  google: { linked: boolean; email: string | null };
  googleEnabled: boolean;
  marketingEmail: boolean;
}

export interface TableCard {
  table: {
    id: string; name: string; kind: string; status: string; game: string; photoUrl: string | null; joinCode: string;
    tournamentId: string | null; activeHandStatus: string | null; activeHandNumber: number | null;
  };
  club: { id: string; publicId: string; name: string; description: string | null; photoUrl: string | null; memberCount: number };
  membershipStatus: string | null;
}

export interface FoundClub {
  club: { id: string; publicId: string; name: string; description: string | null; photoUrl: string | null; memberCount: number };
  membershipStatus: string | null;
}

export const HISTORY_LIMIT = 30;

export const meKeys = {
  games: ['my', 'games'] as const,
  history: ['my', 'history'] as const,
  draws: (id: string) => ['my', 'draws', id] as const,
  identity: ['my', 'identity'] as const,
  requests: ['my', 'requests'] as const,
  balance: ['my', 'balance'] as const,
};

/** Start of the local day, so "today" figures follow the player's clock. */
export function startOfToday(now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

export const useMyGames = () => useQuery({ queryKey: meKeys.games, queryFn: () => api.get<MyGames>('/player/my-games') });

export const useHistory = () => useQuery({
  queryKey: meKeys.history,
  queryFn: () => api.get<History>(`/player/history${qs({ limit: HISTORY_LIMIT, since: startOfToday() })}`),
});

export const useDraws = (couponId: string | null) => useQuery({
  queryKey: meKeys.draws(couponId ?? ''),
  queryFn: () => api.get<CouponDraws>(`/player/coupon/${encodeURIComponent(couponId ?? '')}/draws`),
  enabled: Boolean(couponId),
});

export const useIdentity = () => useQuery({ queryKey: meKeys.identity, queryFn: () => api.get<Identity>('/auth/identity') });

export const useRequests = (enabled = true) => useQuery({
  queryKey: meKeys.requests, queryFn: () => api.get<RequestLists>('/player/requests'), enabled,
});

export const useBalance = (enabled = true) => useQuery({
  queryKey: meKeys.balance, queryFn: () => api.get<{ clubId: string; balanceCents: number }>('/player/balance'), enabled,
});

/** Where a table opens in the player app (the player feature reads `?table=`). */
export const tableHref = (tableId: string): string => `/player?table=${encodeURIComponent(tableId)}`;

/** Market name by slug: the shared dictionary when it has one, otherwise a readable slug. */
export function marketLabel(slug: string): string {
  const key = `market_${slug.replace(/-/g, '_')}`;
  if (hasKey(key)) return t(key);
  const text = slug.replace(/-/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
