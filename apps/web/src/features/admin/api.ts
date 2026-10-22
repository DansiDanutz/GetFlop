import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';

/** Admin screens refresh every 30 s while visible, and on reconnect. */
export const ADMIN_REFRESH_MS = 30_000;

/** Refetches every admin query after the socket reconnects (mounted once by the admin shell). */
export function useAdminReconnect(): void {
  const qc = useQueryClient();
  useSocketEvent('connect', () => { void qc.invalidateQueries({ queryKey: ['admin'] }); });
}

/** A GET against the admin API with the 30-second refresh (paused while the tab is hidden). */
export function useAdmin<T>(key: readonly unknown[], path: string, enabled = true): UseQueryResult<T> {
  return useQuery({
    queryKey: ['admin', ...key],
    queryFn: () => api.get<T>(path),
    refetchInterval: ADMIN_REFRESH_MS,
    refetchIntervalInBackground: false,
    enabled,
  });
}

export type AccountRole = 'player' | 'admin' | 'bot';

export interface AdminUser {
  id: string; username: string; displayName: string; email: string | null; emailVerified: boolean; role: AccountRole;
  isActive: boolean; isAdmin: boolean; isBot: boolean; language: string; createdAt: string; signsInWith: string[];
}

export interface AccountRow extends AdminUser {
  clubs: { id: string; name: string }[];
  lastSeenAt: string | null;
  devices: string[];
}

export interface AccountCounts { all: number; players: number; admins: number; inactive: number; bots: number }
export interface AccountsPage { accounts: AccountRow[]; total: number; counts: AccountCounts }

export interface AccountClub {
  clubId: string; name: string; publicId: string; clubStatus: string; status: string; statusLabel: string;
  roles: string[]; playMode: string; joinedAt: string; lastPlayedAt: string | null; hands: number; balanceCents: number;
}
export interface Movement {
  id: string; clubId: string; clubName: string; kind: string; amountCents: number; balanceAfterCents: number | null;
  note: string | null; createdAt: string;
}
export interface Pick {
  id: string; clubName: string; tableName: string; handNumber: number; market: string; stakeCents: number; multiplier: number;
  status: string; payoutCents: number; voidReason: string | null; createdAt: string;
}
export interface AccountSummary {
  account: AdminUser & { lastSeenAt: string | null };
  clubs: AccountClub[];
  devices: { device: string; signedInAt: string }[];
}
export interface AccountDetail extends AccountSummary {
  movements: Movement[];
  picks: { total: number; items: Pick[] };
}

export interface ClubFigures {
  clubId: string; name: string; publicId: string; hands: number; players: number; picks: number;
  playedCents: number; wonCents: number; resultCents: number; ridingCents: number;
}
export interface MarketReport {
  slug: string; name: string; picks: number; hits: number; hitRate: number; probability: number; low: number; high: number;
  verdict: 'too_few' | 'more' | 'less' | 'as_priced'; retired: boolean;
}
export interface Platform {
  health: { dbMs: number; connections: number };
  kpis: { handsDealt: number; clubsWithHands: number; playersWhoPlayed: number; couponsBought: number; liveCoupons: number; clubs: number; tablesOpen: number };
  online: { connected: number; atTables: number; lobby: number; tables: { tableId: string; users: number; name: string | null; kind: string | null }[] };
  devices: { withApp: number | null; loginsToday: number; list: { userId: string; name: string; device: string; app: boolean | null; signedInAt: string; signedInToday: boolean }[] };
  clubs: ClubFigures[];
  idleClubs: number;
  markets: MarketReport[];
}

export interface AuditLog {
  id: string; action: string; actorId: string | null; actorName: string | null; clubId: string | null; clubName: string | null;
  targetType: string | null; targetId: string | null; targetName: string | null; data: Record<string, unknown>; createdAt: string;
}
export interface AuditPage { logs: AuditLog[]; pagination: { page: number; limit: number; total: number; totalPages: number }; actions: string[] }

export interface Dashboard {
  accounts: AccountCounts;
  clubs: number;
  today: { hands: number; players: number; coupons: number };
  todayClubs: ClubFigures[];
  live: { liveCoupons: number; tablesOpen: number; online: number };
  driftingClubs: { clubId: string; name: string; drift: number }[];
  recentAudit: AuditLog[];
}

export interface LiveTable {
  tableId: string; name: string; clubId: string; clubName: string; kind: string; unit: string; dealerName: string | null;
  isAutoDeal: boolean; liveCoupons: number;
  hand: { id: string; handNumber: number; status: string; picks: number; stakeCents: number } | null;
}
export interface Live { tables: LiveTable[]; totals: { tablesOpen: number; liveHands: number; pendingPicks: number; pendingStakeCents: number; liveCoupons: number } }

export interface AdminTable { id: string; name: string; clubId: string; clubName: string; kind: string; status: string; unit: string; lastHandNumber: number }
export interface HandRow {
  id: string; clubId: string; clubName: string; tableId: string; tableName: string; tableKind: string; unit: string; handNumber: number;
  status: string; flop: string[] | null; picks: number; playedCents: number; paidCents: number; resultCents: number; createdAt: string;
}
export interface HandsPage { hands: HandRow[]; limit: number; truncated: boolean }
export interface BetRow {
  id: string; userId: string; username: string; displayName: string; market: string; marketName: string; stakeCents: number;
  multiplier: number; status: string; payoutCents: number; voidReason: string | null; unit: string;
}
export interface HandBets { hand: { id: string; handNumber: number; tableName: string; clubName: string; status: string; flop: string[] | null }; bets: BetRow[] }

export interface BetType {
  slug: string; name: string; category: string; payoutOdds: number; multiplier: number; probability: number; fairOdds: number;
  fairMultiplier: number; edge: number; isActive: boolean; liveCoupons: number; unresolvedCents: number;
}
export interface BetTypeUpdateResult {
  betType: BetType;
  previous: { payoutOdds: number; multiplier: number; edge: number; isActive: boolean };
  impact: { liveCoupons: number; unresolvedCents: number };
  negativeEdge: boolean;
}

export interface ReconDay {
  date: string; clubId: string; clubName: string; picks: number; playedCents: number; wonCents: number; resultCents: number;
  sentCents: number; claimedCents: number;
}
export interface SupplyCheck {
  clubId: string; clubName: string; drift: number; issuedCents: number; poolCents: number; stocksCents: number;
  walletsCents: number; ridingCents: number; tournamentsCents: number; driftingWallets: number;
}
export interface Reconciliation { days: ReconDay[]; clubs: SupplyCheck[] }
export interface PlayerNet {
  userId: string; name: string; clubId: string; clubName: string; inCents: number; outCents: number; balanceCents: number;
  playedCents: number; wonCents: number; netCents: number;
}
