import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Empty, Spinner } from '../../components/ui';
import { hasKey, useT, type Params } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useSocketEvent } from '../../lib/socket';
import { actionLabelKey } from './MessageView';
import { QUERY_KEYS, type SentLog, type SentMessage } from './types';

const PAGE = 30;

/** Status line of a sent-log entry. */
export function statusLine(m: SentMessage): { key: string; params: Params } {
  switch (m.status) {
    case 'scheduled': return { key: 'msg_goes_out', params: { when: dateTime(m.sendAt) } };
    case 'sent': return { key: 'msg_status_sent', params: { when: dateTime(m.sentAt) } };
    case 'cancelled': return m.sendAt
      ? { key: 'msg_status_cancelled_due', params: { when: dateTime(m.sendAt) } }
      : { key: 'msg_status_cancelled', params: {} };
    case 'failed': return { key: 'msg_status_failed', params: { reason: `msg_fail_${m.failReason ?? 'interrupted'}` } };
  }
}

function audienceText(m: SentMessage, t: (k: string, p?: Params) => string): string {
  if (m.audience === 'member') return t('msg_to_member', { name: m.recipientName ?? '' });
  return hasKey(`msg_aud_${m.audience}`) ? t(`msg_aud_${m.audience}`) : t('msg_all_before');
}

function SentRow({ m, canCancel, onCancel }: { m: SentMessage; canCancel: boolean; onCancel: (m: SentMessage) => void }) {
  const t = useT();
  const status = statusLine(m);
  const statusText = m.status === 'failed' ? t(status.key, { reason: t(String(status.params.reason)) }) : t(status.key, status.params);
  return (
    <li className="card stack msg-sent">
      <div className="row-between">
        <strong className="truncate">{audienceText(m, t)}</strong>
        <span className={`badge ${m.status === 'failed' ? 'closed' : m.status === 'scheduled' ? 'open' : ''}`}>{m.recipientCount}</span>
      </div>
      {m.title && <strong>{m.title}</strong>}
      <p className="msg-body clamp">{m.body}</p>
      <div className="chips faint">
        {m.hasPhoto && <span className="pill">{t('msg_has_photo')}</span>}
        {m.action && <span className="pill">{t(actionLabelKey(m.action), { name: m.action.label })}</span>}
      </div>
      {m.status === 'sent' && (
        <p className="faint">
          {[
            t('msg_stat_opened', { k: m.stats.opened, n: m.stats.reached }),
            t('msg_stat_tapped', { n: m.stats.tapped }),
            m.action ? t('msg_stat_joined', { n: m.stats.joined }) : '',
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      <p className="faint">{statusText} · {t('msg_written_by', { name: m.authorName })}</p>
      {m.status === 'scheduled' && canCancel && (
        <button type="button" className="btn ghost" onClick={() => onCancel(m)}>{t('msg_cancel')}</button>
      )}
    </li>
  );
}

/** The "Sent" tab: waiting messages, then the log with stats; "Show older" pages back. */
export function SentList({ clubId }: { clubId: string | null }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [cancelling, setCancelling] = useState<SentMessage | null>(null);
  const log = useInfiniteQuery({
    queryKey: QUERY_KEYS.sent(clubId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<SentLog>(`/messages/sent${qs({ limit: PAGE, before: pageParam })}`),
    getNextPageParam: (last) => (last.hasMore ? last.messages.at(-1)?.createdAt ?? null : null),
  });
  useSocketEvent('messages:changed', () => { void qc.invalidateQueries({ queryKey: QUERY_KEYS.sent(clubId) }); }, [qc, clubId]);
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/messages/${id}/cancel`),
    onSuccess: () => { toast.show(t('msg_cancelled_ok'), 'success'); void qc.invalidateQueries({ queryKey: ['messages'] }); },
    onError: (err) => toast.error(err),
    onSettled: () => setCancelling(null),
  });

  if (log.isLoading) return <Spinner />;
  const first = log.data?.pages[0];
  const scheduled = first?.scheduled ?? [];
  const messages = log.data?.pages.flatMap((p) => p.messages) ?? [];
  const canCancel = Boolean(first?.canWrite);
  if (scheduled.length === 0 && messages.length === 0) return <Empty icon="✉" title={t('msg_sent_empty')}>{t('msg_sent_empty_sub')}</Empty>;
  return (
    <div className="stack">
      {scheduled.length > 0 && <span className="eyebrow">{t('msg_waiting')}</span>}
      <ul className="stack msg-list">{scheduled.map((m) => <SentRow key={m.id} m={m} canCancel={canCancel} onCancel={setCancelling} />)}</ul>
      <ul className="stack msg-list">{messages.map((m) => <SentRow key={m.id} m={m} canCancel={false} onCancel={setCancelling} />)}</ul>
      {log.hasNextPage && (
        <button type="button" className="btn ghost block" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>{t('msg_show_older')}</button>
      )}
      <ConfirmSheet open={Boolean(cancelling)} title={t('msg_cancel_title')} body={t('msg_cancel_body')} danger busy={cancel.isPending}
        confirmLabel={t('msg_cancel')} cancelLabel={t('msg_cancel_keep')}
        onConfirm={() => cancelling && cancel.mutate(cancelling.id)} onCancel={() => setCancelling(null)} />
    </div>
  );
}
