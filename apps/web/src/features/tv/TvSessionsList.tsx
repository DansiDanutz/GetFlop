import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { ago, dateTime } from '../../lib/format';
import { tvApi } from './api';
import type { TvKind, TvSessionInfo } from './types';

export const sessionsKey = (kind: TvKind, targetId: string) => ['tv-sessions', kind, targetId] as const;

/** Staff: the TVs currently showing a table or tournament, each with a Disconnect button. */
export function TvSessionsList({ kind, targetId }: { kind: TvKind; targetId: string }) {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<TvSessionInfo | null>(null);
  const sessions = useQuery({ queryKey: sessionsKey(kind, targetId), queryFn: () => tvApi.sessions(kind, targetId) });
  const revoke = useMutation({
    mutationFn: (id: string) => tvApi.revoke(id),
    onSuccess: () => {
      toast.show(t('tv_session_revoked'), 'success');
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: sessionsKey(kind, targetId) });
    },
    onError: (err) => toast.error(err),
  });

  const list = sessions.data?.sessions ?? [];
  return (
    <section className="stack tv-sessions">
      <h3>{t('tv_sessions_title')}</h3>
      {sessions.isLoading && <Spinner />}
      {sessions.isError && <p className="field-error">{t('tv_load_failed')}</p>}
      {sessions.isSuccess && list.length === 0 && <p className="muted">{t('tv_sessions_empty')}</p>}
      <div className="list">
        {list.map((s) => (
          <div key={s.id} className="list-row">
            <div className="grow">
              <strong>{t(s.via === 'link' ? 'tv_session_via_link' : 'tv_session_via_pairing')}</strong>
              <div className="faint">
                {t('tv_session_until', { time: dateTime(s.expiresAt) })} · {s.lastSeenAt ? t('tv_session_seen', { ago: ago(s.lastSeenAt) }) : t('tv_session_never_seen')}
              </div>
            </div>
            <button type="button" className="btn ghost" onClick={() => setConfirming(s)}>{t('tv_session_revoke')}</button>
          </div>
        ))}
      </div>
      <ConfirmSheet
        open={confirming !== null}
        title={t('tv_session_revoke_confirm')}
        body={t('tv_session_revoke_body')}
        confirmLabel={t('tv_session_revoke')}
        cancelLabel={t('cancel')}
        danger
        busy={revoke.isPending}
        onConfirm={() => { if (confirming) revoke.mutate(confirming.id); }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}
