import { api, ApiError, qs } from '../../lib/api';
import type { SetupStep } from './logic';

export type MemberStatus = 'active' | 'pending' | 'left' | 'removed';
export type MemberFilter = 'all' | 'players' | 'staff' | 'owner' | 'manager' | 'inspector' | 'dealer' | 'pending' | 'ended';

export interface MemberRow {
  userId: string; username: string; displayName: string; roles: string[]; playMode: 'play' | 'watch'; status: MemberStatus;
  via: string; joinedAt: string; lastPlayedAt: string | null; endedAt: string | null;
  endedBy: { userId: string; name: string } | null; reason: string | null; balanceCents?: number; stockCents?: number;
}

export interface MembersResponse {
  actor: { userId: string; roles: string[]; isAdmin: boolean };
  members: MemberRow[];
  counts: { active: number; pending: number; ended: number };
}

export interface Figures {
  hands: number; playedCents: number; wonCents: number; resultCents: number; sentOutCents: number; claimedBackCents: number;
}

export interface MarketFigure { market: string; picks: number; playedCents: number; hits: number; hitRate: number; expectedRate: number | null }

export interface Movement {
  id: string; kind: string; createdAt: string; note: string | null; account: 'wallet' | 'stock';
  amountCents: number; balanceAfterCents: number | null; actor: { userId: string; name: string; isSelf: boolean } | null;
}

export interface MemberCard {
  member: {
    userId: string; username: string; displayName: string; roles: string[]; playMode: 'play' | 'watch'; status: MemberStatus;
    via: string; joinedAt: string; lastPlayedAt: string | null; balanceCents: number; stockCents?: number;
  };
  stats: { period: Figures; all: Figures };
  markets: MarketFigure[];
  movements: Movement[];
}

export interface CouponSummary {
  id: string; tableName: string; unit: string; status: 'live' | 'completed' | 'voided'; rounds: number; roundsSettled: number;
  committedCents: number; wonCents: number; refundedCents: number; stillAtStakeCents: number; createdAt: string;
  picks: { market: string; stakeCents: number; multiplier: number; status: string }[];
}

export interface CouponDetail {
  coupon: CouponSummary;
  draws: { handNumber: number; status: string; flop: string[] | null; picks: { market: string; stakeCents: number; status: string; payoutCents: number }[] }[];
}

export interface JoinRequest {
  membershipId: string; userId: string; username: string; displayName: string | null; via: string; playMode: string; createdAt: string;
}

export interface Room { id: string; name: string; tables: number; reserved: boolean }

export interface ClubSettings {
  id: string; publicId: string; name: string; description: string | null; photoUrl: string | null; level: string;
  dealerSitApproval: boolean; liveBigCents: number; boardEnabled: boolean; inviteUrl: string; rooms: Room[];
}

export interface Setup { complete: boolean; done: number; total: number; steps: SetupStep[] }

export interface Supply {
  pool: number; inStocks: number; inWallets: number; riding: number; inTournaments: number;
  issued: number; gameBurned: number; gameMinted: number; drift: number;
}

export interface SupplyDetail {
  stocks: { userId: string; name: string; stockCents: number }[];
  mints: { id: string; amountCents: number; note: string | null; createdAt: string; by: string | null }[];
  reservedCents: number;
}

export interface DeleteCheck {
  blockers: Record<string, number>; members: number; pointsCents: number; diamonds: number; restoreDays: number;
}

export interface ScanResult {
  state: 'active' | 'pending' | 'left' | 'removed' | 'none';
  player: { id: string; displayName: string; username: string };
  endedAt?: string | null;
}

export type Range = { dateStart: string; dateEnd: string; tz: string } | null;

const c = (clubId: string) => `/clubs/${encodeURIComponent(clubId)}`;
const m = (clubId: string, userId: string) => `${c(clubId)}/members/${encodeURIComponent(userId)}`;

/** Every call the owner/manager screens make (spied on in tests). */
export const ownerApi = {
  members: (clubId: string, filter: MemberFilter, q = '') => api.get<MembersResponse>(`${c(clubId)}/members${qs({ filter, q })}`),
  joinRequests: (clubId: string) => api.get<{ requests: JoinRequest[] }>(`${c(clubId)}/join-requests`),
  reviewJoin: (clubId: string, membershipId: string, decision: 'approve' | 'reject') =>
    api.post(`${c(clubId)}/join-requests/${membershipId}/${decision}`, {}),
  card: (clubId: string, userId: string, range: Range) => api.get<MemberCard>(`${m(clubId, userId)}${qs(range ?? {})}`),
  coupons: (clubId: string, userId: string, offset: number) =>
    api.get<{ coupons: CouponSummary[]; more: boolean }>(`${m(clubId, userId)}/coupons${qs({ offset })}`),
  coupon: (clubId: string, userId: string, couponId: string) => api.get<CouponDetail>(`${m(clubId, userId)}/coupons/${couponId}`),
  grantRole: (clubId: string, userId: string, role: string) => api.post<{ roles: string[] }>(`${m(clubId, userId)}/roles/${role}`, {}),
  revokeRole: (clubId: string, userId: string, role: string) => api.del<{ roles: string[] }>(`${m(clubId, userId)}/roles/${role}`),
  playMode: (clubId: string, userId: string, mode: 'play' | 'watch') => api.put(`${m(clubId, userId)}/play-mode`, { mode }),
  remove: (clubId: string, userId: string, reason?: string) => api.post<{ returnedCents: number }>(`${m(clubId, userId)}/remove`, { reason }),
  transfer: (clubId: string, userId: string) => api.post(`${c(clubId)}/owner/transfer`, { userId }),
  leave: (clubId: string, reason?: string) => api.post<{ returnedCents: number }>(`${c(clubId)}/leave`, { reason }),
  sendOrClaim: (clubId: string, userId: string, direction: 'load' | 'withdraw', amountCents: number, note?: string) =>
    api.post<{ balanceCents: number }>(`/inspector/player/${encodeURIComponent(userId)}/${direction}${qs({ clubId })}`, { amountCents, note }),
  stock: (clubId: string, userId: string, direction: 'give' | 'take', amountCents: number, note?: string) =>
    api.post<{ stockCents: number }>(`${m(clubId, userId)}/stock`, { direction, amountCents, note }),
  settings: (clubId: string) => api.get<ClubSettings>(`${c(clubId)}/settings`),
  saveProfile: (clubId: string, body: { name?: string; description?: string | null; logo?: string | null }) =>
    api.put<ClubSettings>(`${c(clubId)}/profile`, body),
  saveSettings: (clubId: string, body: { dealerSitApproval?: boolean; liveBigPoints?: string; boardEnabled?: boolean }) =>
    api.put<ClubSettings>(`${c(clubId)}/settings`, body),
  setup: (clubId: string) => api.get<{ setup: Setup }>(`${c(clubId)}/setup`),
  inviteShared: (clubId: string) => api.post(`${c(clubId)}/invite/shared`, {}),
  addRoom: (clubId: string, name: string) => api.post(`${c(clubId)}/rooms`, { name }),
  renameRoom: (clubId: string, roomId: string, name: string) => api.put(`${c(clubId)}/rooms/${roomId}`, { name }),
  deleteRoom: (clubId: string, roomId: string) => api.del(`${c(clubId)}/rooms/${roomId}`),
  supply: (clubId: string) => api.get<Supply>(`${c(clubId)}/points`),
  supplyDetail: (clubId: string) => api.get<SupplyDetail>(`${c(clubId)}/points/detail`),
  mint: (clubId: string, amount: string, reason: string, key: string) =>
    requestWithKey(`${c(clubId)}/points/mint`, { amount, reason }, key),
  deleteCheck: (clubId: string) => api.get<DeleteCheck>(`${c(clubId)}/delete-check`),
  deleteClub: (clubId: string, confirmName: string, reason: string) => api.post(`${c(clubId)}/delete`, { confirmName, reason }),
  playerCode: () => api.get<{ code: string; rotatesInSeconds: number }>('/clubs/player-code'),
  scan: (clubId: string, code: string) => api.post<ScanResult>(`${c(clubId)}/scan`, { code }),
  scanRequest: (clubId: string, code: string, confirmReturn: boolean) => api.post<ScanResult>(`${c(clubId)}/scan/request`, { code, confirmReturn }),
  myClubs: () => api.get<{ clubs: { id: string; name: string; roles: string[]; membershipStatus: string }[] }>('/clubs/mine'),
};

/** POST with an Idempotency-Key header (mint), through the shared fetch wrapper's envelope handling. */
async function requestWithKey(path: string, body: unknown, key: string): Promise<Supply> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST', credentials: 'include', body: JSON.stringify(body),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    });
  } catch {
    throw new ApiError('network.offline', 0);
  }
  const json = (await res.json().catch(() => null)) as { success: boolean; data?: Supply; error?: { code: string; params?: Record<string, string | number> } } | null;
  if (!json) throw new ApiError('server.error', res.status);
  if (!json.success) throw new ApiError(json.error?.code ?? 'server.error', res.status, json.error?.params ?? {});
  return json.data as Supply;
}

export const newIdempotencyKey = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
