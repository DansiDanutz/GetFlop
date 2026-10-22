import { api, qs } from '../../lib/api';

export type HandStatus = 'betting_open' | 'betting_closed' | 'settled' | 'cancelled';

export interface Hand {
  id: string;
  handNumber: number;
  status: HandStatus;
  flop: string[] | null;
  totalBets: number;
  winningBets: number;
  totalWageredCents: number;
  totalPaidOutCents: number;
  bettingClosesAt: string | null;
  dealtBy: string;
  createdAt: string;
  settledAt: string | null;
}

export interface DealerTable {
  id: string;
  clubId: string;
  clubName?: string;
  name: string;
  game: string;
  kind: 'cash' | 'tournament' | string;
  status: 'open' | 'closed' | string;
  isAutoDeal: boolean;
  dealerId: string | null;
  joinCode: string;
  unit: string;
  lastHandNumber: number;
  currentHand: Hand | null;
  lastHand: Hand | null;
  tournament: 'soon' | 'live' | null;
}

export interface SitRequest {
  id: string;
  clubId: string;
  clubName: string;
  tableId: string;
  tableName: string;
  status: string;
  createdAt: string;
}

export interface Notice {
  id: string;
  code: string;
  params: Record<string, string | number>;
}

export type SitResponse =
  | { status: 'seated'; table: DealerTable }
  | { status: 'requested'; request: SitRequest };

export interface Available {
  tables: DealerTable[];
  needsApproval: boolean;
  pending: SitRequest | null;
}

export interface CurrentHand {
  table: DealerTable;
  hand: Hand | null;
  live: { players: number; picks: number };
}

export interface ScanResult {
  cards: string[];
  confidence: 'high' | 'low';
}

export const dealerKeys = {
  all: ['dealer'] as const,
  tables: ['dealer', 'tables'] as const,
  available: ['dealer', 'available'] as const,
  notices: ['dealer', 'notices'] as const,
  current: (id: string) => ['dealer', 'current', id] as const,
  hands: (id: string) => ['dealer', 'hands', id] as const,
};

const RECENT_HANDS = 20;

export const dealerApi = {
  tables: () => api.get<{ tables: DealerTable[] }>('/dealer/tables'),
  available: () => api.get<Available>('/dealer/available-tables'),
  notices: () => api.get<{ notices: Notice[] }>('/dealer/notices'),
  readNotice: (id: string) => api.post<{ read: boolean }>(`/dealer/notices/${id}/read`),
  sit: (tableId: string) => api.post<SitResponse>(`/dealer/table/${tableId}/sit`),
  switchTo: (tableId: string, heldTableId: string) => api.post<SitResponse>(`/dealer/table/${tableId}/switch`, { heldTableId }),
  leave: (tableId: string) => api.post<{ table: DealerTable }>(`/dealer/table/${tableId}/leave`),
  leaveHeld: () => api.post<{ table: string; club: string }>('/dealer/held/leave'),
  cancelRequest: (id: string) => api.post(`/dealer/sit-requests/${id}/cancel`),
  current: (tableId: string) => api.get<CurrentHand>(`/dealer/table/${tableId}/current-hand`),
  hands: (tableId: string) => api.get<{ hands: Hand[]; unit: string }>(`/dealer/table/${tableId}/hands${qs({ limit: RECENT_HANDS })}`),
  startHand: (tableId: string) => api.post<{ hand: Hand; bettingTimerSeconds: number | null }>(`/dealer/table/${tableId}/start-hand`),
  noMorePicks: (tableId: string) => api.post<{ hand: Hand }>(`/dealer/table/${tableId}/no-more-bets`),
  cancelHand: (tableId: string) => api.post<{ hand: Hand }>(`/dealer/table/${tableId}/cancel-hand`),
  enterFlop: (tableId: string, cards: readonly string[]) =>
    api.post<{ hand: Hand }>(`/dealer/table/${tableId}/enter-flop`, { card1: cards[0], card2: cards[1], card3: cards[2] }),
  scanFlop: (tableId: string, image: string) =>
    api.post<ScanResult>(`/dealer/table/${tableId}/scan-flop`, { image, mediaType: 'image/jpeg' }),
};

/** Live hand = picks open or closed, flop not entered yet. */
export function isLive(hand: Hand | null | undefined): boolean {
  return hand?.status === 'betting_open' || hand?.status === 'betting_closed';
}

/** Which buttons the console dock shows. */
export type DockMode = 'auto' | 'new' | 'open' | 'closed';

export function dockMode(table: Pick<DealerTable, 'isAutoDeal'>, hand: Hand | null | undefined): DockMode {
  if (hand?.status === 'betting_open') return 'open';
  if (hand?.status === 'betting_closed') return 'closed';
  return table.isAutoDeal ? 'auto' : 'new';
}

/** Translation key for a table's status badge on the table list. */
export function tableBadgeKey(table: Pick<DealerTable, 'status' | 'currentHand'>): string {
  if (table.status !== 'open') return 'dealer_badge_closed';
  if (table.currentHand?.status === 'betting_open') return 'dealer_badge_picks_open';
  if (table.currentHand?.status === 'betting_closed') return 'dealer_badge_dealing';
  return 'dealer_badge_open';
}
