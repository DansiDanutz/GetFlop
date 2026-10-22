import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Empty, Segmented, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { amount, dateTime } from '../../lib/format';
import { useSession } from '../../state/session';
import { INSP, useJoinRequests, usePending, useRequestHistory } from './api';
import { historyLabels, pendingGroups, playerName, returnUncovered, stockShort, type PendingItem } from './model/requests';
import { StaffFrame } from './StaffFrame';

type Decision = { item: PendingItem; decision: 'approve' | 'reject' };

function endpoint(d: Decision, clubId: string): string {
  const { item, decision } = d;
  if (item.group === 'join') return `/clubs/${clubId}/join-requests/${item.join.membershipId}/${decision}`;
  if (item.group === 'dealer_sit') return `/inspector/dealer-sit/${item.sit.id}/${decision}`;
  return `/inspector/request/${item.request.id}/${decision}`;
}

function ItemRow({ item, onDecide, myStock }: { item: PendingItem; myStock: number | null; onDecide: (d: Decision) => void }) {
  const t = useT();
  const who = item.group === 'join' ? playerName(item.join) : item.group === 'dealer_sit' ? item.sit.dealerName : playerName(item.request);
  return (
    <div className="list-row insp-request">
      <div className="grow insp-rowtext">
        <strong>{who}</strong>
        {(item.group === 'points_in' || item.group === 'points_out') && (
          <span className="muted insp-sub">
            {amount(item.request.amountCents)}
            {typeof item.request.balanceCents === 'number' && ` · ${t('insp_req_balance', { amount: amount(item.request.balanceCents) })}`}
          </span>
        )}
        {item.group === 'dealer_sit' && <span className="muted insp-sub">{t('insp_req_sit_at', { table: item.sit.tableName })}</span>}
        <span className="faint insp-sub">{dateTime(item.createdAt)}</span>
        {item.group !== 'join' && item.group !== 'dealer_sit' && returnUncovered(item.request) && <span className="field-error">{t('insp_req_not_covered')}</span>}
        {item.group === 'points_in' && stockShort(item.request, myStock) && <span className="field-error">{t('insp_req_stock_short')}</span>}
      </div>
      <button type="button" className="btn ghost" onClick={() => onDecide({ item, decision: 'reject' })}>{t('insp_reject')}</button>
      <button type="button" className="btn go" onClick={() => onDecide({ item, decision: 'approve' })}>{t('insp_approve')}</button>
    </div>
  );
}

/** Requests tab: Pending (Points in / out, join, dealer seat) and 30-day History (07 §3, 04 §6.1). */
export function Requests() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { context } = useSession();
  const clubId = context?.club.id ?? '';
  const [view, setView] = useState<'pending' | 'history'>('pending');
  const pending = usePending();
  const joins = useJoinRequests(clubId || undefined);
  const history = useRequestHistory(view === 'history');
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = pendingGroups(pending.data, joins.data);
  const myStock = pending.data?.myStock ?? null;

  async function confirm() {
    if (!deciding) return;
    setBusy(true);
    try {
      const body = deciding.decision === 'reject' && reason.trim() ? { reason: reason.trim() } : {};
      await api.post(endpoint(deciding, clubId), body);
      toast.show(t(deciding.decision === 'approve' ? 'insp_toast_approved' : 'insp_toast_rejected'), 'success');
      setDeciding(null);
      setReason('');
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const movesPoints = deciding && (deciding.item.group === 'points_in' || deciding.item.group === 'points_out') && deciding.decision === 'approve';

  return (
    <StaffFrame>
      <Segmented value={view} onChange={setView}
        options={[{ value: 'pending', label: t('insp_req_pending') }, { value: 'history', label: t('insp_req_history') }]} />
      {myStock !== null && <div className="banner">{t('insp_req_my_stock', { amount: amount(myStock) })}</div>}
      {view === 'pending' && (
        <>
          {(pending.isLoading || joins.isLoading) && <Spinner />}
          {pending.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
          {pending.data && groups.length === 0 && <Empty icon="✓" title={t('insp_req_none')} />}
          {groups.map((g) => (
            <section key={g.key} className="stack">
              <span className="section-title">{t(`insp_req_group_${g.key}`, { n: g.items.length })}</span>
              <div className="card tight list">
                {g.items.map((item) => <ItemRow key={`${item.group}-${item.id}`} item={item} myStock={myStock} onDecide={setDeciding} />)}
              </div>
            </section>
          ))}
        </>
      )}
      {view === 'history' && (
        <>
          {history.isLoading && <Spinner />}
          {history.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
          {history.data && history.data.length === 0 && <Empty title={t('insp_req_history_empty')} />}
          <div className="card tight list">
            {(history.data ?? []).map((h) => {
              const labels = historyLabels(h);
              return (
                <div key={h.id} className="list-row">
                  <div className="grow insp-rowtext">
                    <strong>{playerName(h)}</strong>
                    <span className="muted insp-sub">{t(labels.typeKey)} · {amount(h.amountCents)}</span>
                    <span className="faint insp-sub">{dateTime(h.reviewedAt ?? h.createdAt)}{h.rejectionReason ? ` · ${h.rejectionReason}` : ''}</span>
                  </div>
                  <span className={`badge ${h.status === 'approved' ? 'live' : 'closed'}`}>{t(labels.statusKey)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <Sheet open={Boolean(deciding)} onClose={() => setDeciding(null)} modal
        title={deciding ? t(deciding.decision === 'approve' ? 'insp_approve_title' : 'insp_reject_title') : ''}>
        {movesPoints && <div className="banner">{t('insp_moves_points_now')}</div>}
        {deciding?.decision === 'reject' && deciding.item.group !== 'dealer_sit' && (
          <label className="stack">
            <span className="eyebrow">{t('insp_reject_reason')}</span>
            <input value={reason} maxLength={200} placeholder={t('insp_reject_reason_ph')} onChange={(e) => setReason(e.target.value)} />
          </label>
        )}
        <div className="grid-2">
          <button type="button" className="btn ghost" disabled={busy} onClick={() => setDeciding(null)}>{t('insp_cancel')}</button>
          <button type="button" className={`btn ${deciding?.decision === 'approve' ? 'go' : 'danger'}`} disabled={busy} onClick={() => void confirm()}>
            {t(deciding?.decision === 'approve' ? 'insp_approve' : 'insp_reject')}
          </button>
        </div>
      </Sheet>
    </StaffFrame>
  );
}
