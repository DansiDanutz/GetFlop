import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { api, ApiError, setApiClub, setUnauthorizedHandler } from '../lib/api';
import { closeSocket, getSocket } from '../lib/socket';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: 'player' | 'admin';
  email: string | null;
  emailVerified: boolean;
  language: string;
  activeClubId: string | null;
  playerCode: string;
  termsRequired: boolean;
}

export type Surface = 'player' | 'dealer' | 'inspector' | 'club';

export interface ClubContext {
  club: { id: string; name: string; publicId: string; photoUrl: string | null; level: string; inviteToken: string };
  roles: string[];
  playMode: 'play' | 'watch';
  surfaces: Surface[];
  capabilities: string[];
}

interface Session {
  user: User | null;
  loading: boolean;
  context: ClubContext | null;
  contextLoading: boolean;
  can(capability: string): boolean;
  refresh(): Promise<void>;
  selectClub(clubId: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api.get<{ user: User }>('/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
  const user = me.data ?? null;
  useEffect(() => { setApiClub(user?.activeClubId ?? null); }, [user?.activeClubId]);

  const ctxQuery = useQuery({
    queryKey: ['club-context', user?.activeClubId],
    queryFn: () => api.get<ClubContext>('/clubs/context'),
    enabled: Boolean(user?.activeClubId),
    staleTime: 15_000,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => { qc.setQueryData(['me'], null); });
  }, [qc]);

  useEffect(() => {
    if (!user) { closeSocket(); return; }
    const s = getSocket();
    const invalidateContext = () => qc.invalidateQueries({ queryKey: ['club-context'] });
    const ended = () => { qc.setQueryData(['me'], null); closeSocket(); };
    s.on('club:context-changed', invalidateContext);
    s.on('club:membership-changed', () => { invalidateContext(); qc.invalidateQueries({ queryKey: ['clubs'] }); });
    s.on('session:ended', ended);
    return () => { s.off('club:context-changed', invalidateContext); s.off('session:ended', ended); };
  }, [user, qc]);

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
    await qc.invalidateQueries({ queryKey: ['club-context'] });
  }, [qc]);

  const selectClub = useCallback(async (clubId: string) => {
    await api.post('/clubs/select', { clubId });
    setApiClub(clubId);
    getSocket().emit('join-club', clubId);
    qc.setQueryData<User | null>(['me'], (u) => (u ? { ...u, activeClubId: clubId } : u));
    await qc.invalidateQueries({ queryKey: ['club-context'] });
  }, [qc]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    closeSocket();
    setApiClub(null);
    qc.clear();
    qc.setQueryData(['me'], null);
  }, [qc]);

  const context = ctxQuery.data ?? null;
  const value = useMemo<Session>(() => ({
    user,
    loading: me.isLoading,
    context,
    contextLoading: ctxQuery.isLoading && Boolean(user?.activeClubId),
    can: (capability) => Boolean(context?.capabilities.includes(capability)),
    refresh, selectClub, logout,
  }), [user, me.isLoading, context, ctxQuery.isLoading, refresh, selectClub, logout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}
