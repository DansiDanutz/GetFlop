import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { useSocketEvent } from '../../lib/socket';
import { useSession } from '../../state/session';
import { actionPath } from './logic';
import { QUERY_KEYS, type Inbox, type TapResult } from './types';

/** My inbox (all clubs). Refreshes when a message:new arrives. */
export function useInbox(enabled = true) {
  const qc = useQueryClient();
  const { user } = useSession();
  useSocketEvent('message:new', () => { void qc.invalidateQueries({ queryKey: ['messages'] }); }, [qc]);
  return useQuery({
    queryKey: QUERY_KEYS.inbox,
    queryFn: () => api.get<Inbox>('/messages'),
    enabled: enabled && Boolean(user),
    staleTime: 30_000,
  });
}

/** Unread badge count for the inbox button. */
export function useInboxUnread(): number {
  return useInbox().data?.unread ?? 0;
}

/** The photo of a message as a data URL (null once removed). */
export function useMessagePhoto(messageId: string | null) {
  return useQuery({
    queryKey: ['messages', 'photo', messageId],
    queryFn: () => api.get<{ photo: string | null }>(`/messages/${messageId}/photo`),
    enabled: Boolean(messageId),
    staleTime: Infinity,
  });
}

/** Button tap: records it, switches club when needed, then opens the table or tournament. */
export function useTapAction(): (messageId: string) => Promise<void> {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user, selectClub } = useSession();
  return useCallback(async (messageId: string) => {
    try {
      const result = await api.post<TapResult>(`/messages/${messageId}/tap`);
      void qc.invalidateQueries({ queryKey: QUERY_KEYS.inbox });
      if (!result.available) {
        toast.show(t('inbox_unavailable'));
        return;
      }
      if (user?.activeClubId !== result.clubId) await selectClub(result.clubId);
      navigate(actionPath(result));
    } catch (err) {
      toast.error(err);
    }
  }, [t, toast, navigate, qc, user?.activeClubId, selectClub]);
}
