import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '../../lib/api';
import { onSocketStatus, useSocketEvent } from '../../lib/socket';
import type { Dashboard } from './model/floor';
import type { MarketInfo, LimitsPayload } from './model/limits';
import type { JoinRequest, PendingRequests, PointsRequest } from './model/requests';

/** Every inspector query key starts with this, so one invalidation refreshes the surface. */
export const INSP = 'insp';
export const FLOOR_REFRESH_MS = 30_000;
export const LIVE_REFRESH_MS = 15_000;
const FLOOR_DEBOUNCE_MS = 1_200;

export interface TableView {
  id: string;
  name: string;
  game: string;
  photoUrl: string | null;
  featured: boolean;
  kind: string;
  status: string;
  isAutoDeal: boolean;
  dealerId: string | null;
  dealerName: string | null;
  joinCode: string;
  limits: LimitsPayload;
  markets: string[];
  offered: MarketInfo[];
  currentHand: { handNumber: number; status: string } | null;
}

export interface Dealer { id: string; username: string; displayName: string; assignedTable: string | null; assignedTableId: string | null; busyElsewhere: boolean }

export interface ClosePreview {
  table: { id: string; name: string; kind: string };
  hasActiveHand: boolean;
  activeHandNumber: number | null;
  couponCount: number;
  playerCount: number;
  totalRefundCents: number;
  coupons: { couponId: string; userId: string; player: string; drawsLeft: number; refundCents: number }[];
  tournamentName: string | null;
  tournamentRunning: boolean;
}

export interface DeletePreview {
  mode: 'delete' | 'archive';
  history: { hands: number; coupons: number };
  dealer: { id: string; name: string } | null;
  blocked: { code: string; params: Record<string, string | number> } | null;
}

export interface SetupStatus { complete: number; total: number; steps: { key: string; done: boolean; optional?: boolean }[] }

export const useDashboard = () => useQuery({
  queryKey: [INSP, 'dashboard'],
  queryFn: () => api.get<Dashboard>('/inspector/dashboard'),
  refetchInterval: FLOOR_REFRESH_MS,
});

export const useTables = () => useQuery({
  queryKey: [INSP, 'tables'],
  queryFn: async () => (await api.get<{ tables: TableView[] }>('/inspector/tables')).tables,
});

export const useCatalogue = () => useQuery({
  queryKey: [INSP, 'catalogue'],
  queryFn: async () => (await api.get<{ betTypes: MarketInfo[] }>('/tournaments/bet-types/list')).betTypes,
  staleTime: 5 * 60_000,
});

export const useDealers = (enabled = true) => useQuery({
  queryKey: [INSP, 'dealers'],
  queryFn: async () => (await api.get<{ dealers: Dealer[] }>('/inspector/dealers')).dealers,
  enabled,
});

export const usePending = () => useQuery({
  queryKey: [INSP, 'requests'],
  queryFn: () => api.get<PendingRequests>('/inspector/requests'),
  refetchInterval: FLOOR_REFRESH_MS,
});

export const useJoinRequests = (clubId: string | undefined) => useQuery({
  queryKey: [INSP, 'joins', clubId],
  queryFn: async () => (await api.get<{ requests: JoinRequest[] }>(`/clubs/${clubId}/join-requests`)).requests,
  enabled: Boolean(clubId),
  refetchInterval: FLOOR_REFRESH_MS,
});

export const useRequestHistory = (enabled: boolean) => useQuery({
  queryKey: [INSP, 'history'],
  queryFn: async () => (await api.get<{ items: PointsRequest[] }>('/inspector/requests/history?days=30')).items,
  enabled,
});

/** The owner's setup checklist; hidden on any error (another module serves it). */
export const useSetup = (clubId: string | undefined, enabled: boolean) => useQuery({
  queryKey: [INSP, 'setup', clubId],
  queryFn: () => api.get<SetupStatus>(`/clubs/${clubId}/setup`),
  enabled: enabled && Boolean(clubId),
  retry: false,
});

/**
 * Keeps the staff surface fresh: floor:changed (debounced 1.2 s), request and
 * dealer-sit events, live:changed, and a refetch after a reconnect.
 */
export function useInspectorLive(onEvent?: (event: string, payload: unknown) => void): void {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: [INSP] });
  const debounced = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, FLOOR_DEBOUNCE_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    const off = onSocketStatus((s) => { if (s === 'connected') void qc.invalidateQueries({ queryKey: [INSP] }); });
    return () => { off(); };
  }, [qc]);
  useSocketEvent('floor:changed', debounced);
  useSocketEvent('live:changed', debounced);
  for (const event of ['request:new', 'request:resolved', 'join-request:new', 'join-request:resolved', 'dealer-sit:new', 'dealer-sit:resolved']) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed list, same order every render
    useSocketEvent(event, (payload) => { refresh(); onEvent?.(event, payload); });
  }
}
