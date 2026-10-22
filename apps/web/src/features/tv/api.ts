import { api, qs } from '../../lib/api';
import type {
  CashTvData, ClaimResponse, DirectLinkResponse, PairingResponse, TournamentTvData, TvKind, TvSessionInfo,
} from './types';

const targetBody = (kind: TvKind, targetId: string) => (kind === 'cash' ? { tableId: targetId } : { tournamentId: targetId });

export const tvApi = {
  // TV (display token only)
  claim: (kind: TvKind, code: string) => api.post<ClaimResponse>(`/tv/${kind}-pairings/claim`, { code }),
  cash: (token: string) => api.get<CashTvData>(`/tv/cash/${encodeURIComponent(token)}`),
  tournament: (token: string) => api.get<TournamentTvData>(`/tv/tournament/${encodeURIComponent(token)}`),

  // Staff phone
  createPairing: (kind: TvKind, targetId: string) => api.post<PairingResponse>(`/tv/${kind}-pairings`, targetBody(kind, targetId)),
  createLink: (kind: TvKind, targetId: string) => api.post<DirectLinkResponse>(`/tv/${kind}-sessions`, targetBody(kind, targetId)),
  sessions: (kind: TvKind, targetId: string) => api.get<{ sessions: TvSessionInfo[] }>(`/tv/sessions${qs({ kind, targetId })}`),
  revoke: (sessionId: string) => api.del<{ revoked: boolean }>(`/tv/sessions/${encodeURIComponent(sessionId)}`),
};
