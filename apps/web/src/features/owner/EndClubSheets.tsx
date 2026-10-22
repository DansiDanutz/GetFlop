import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { useSession } from '../../state/session';
import { ownerApi } from './api';

const BLOCKER_LINKS: Record<string, string> = {
  openTables: '/inspector', tournaments: '/inspector', requests: '/club/requests', returns: '/club/requests',
  seatedDealers: '/inspector', liveCoupons: '/inspector',
};

/** Owner deletes the club: blockers with shortcuts, consequences, typed name and reason (03 §12). */
export function DeleteClubSheet({ open, onClose, clubId, clubName }: { open: boolean; onClose: () => void; clubId: string; clubName: string }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const check = useQuery({ queryKey: ['owner', 'delete-check', clubId], queryFn: () => ownerApi.deleteCheck(clubId), enabled: open });
  const blockers = Object.entries(check.data?.blockers ?? {}).filter(([, n]) => n > 0);

  async function remove() {
    setBusy(true);
    try {
      await ownerApi.deleteClub(clubId, name.trim(), reason.trim());
      toast.show(t('own_delete_done', { club: clubName }), 'success');
      qc.clear();
      await refresh();
      navigate('/clubs');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('own_delete_title')} modal>
      {check.isLoading && <Spinner />}
      {check.data && (
        <div className="stack">
          {blockers.length > 0 ? (
            <div className="banner danger stack">
              <strong>{t('own_delete_blocked')}</strong>
              {blockers.map(([key, n]) => (
                <div key={key} className="row-between">
                  <span>{t(`own_blocker_${key}`, { n })}</span>
                  <Link className="btn link" to={BLOCKER_LINKS[key] ?? '/inspector'} onClick={onClose}>{t('own_open')}</Link>
                </div>
              ))}
            </div>
          ) : (
            <div className="banner">{t('own_delete_ready')}</div>
          )}
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('own_delete_members', { n: check.data.members })}</li>
            <li>{t('own_delete_points', { amount: amount(check.data.pointsCents) })}</li>
            <li>{t('own_delete_diamonds', { n: check.data.diamonds })}</li>
            <li>{t('own_delete_restore', { days: check.data.restoreDays })}</li>
          </ul>
          <label>{t('own_delete_type_name', { club: clubName })}<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
          <label>{t('own_delete_reason')}<input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} /></label>
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
            <button type="button" className="btn danger" disabled={busy || blockers.length > 0 || name.trim() !== clubName || !reason.trim()} onClick={() => void remove()}>
              {t('own_delete_cta')}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

/** A member (not the owner) leaves the club; the balance returns to the club (03 §8). */
export function LeaveClubSheet({ open, onClose, clubId, clubName }: { open: boolean; onClose: () => void; clubId: string; clubName: string }) {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { refresh } = useSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function leave() {
    setBusy(true);
    try {
      const { returnedCents } = await ownerApi.leave(clubId, reason.trim() || undefined);
      toast.show(t('own_leave_done', { club: clubName, amount: amount(returnedCents) }), 'success');
      qc.clear();
      await refresh();
      navigate('/clubs');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('own_leave_title', { club: clubName })} modal>
      <p className="muted">{t('own_leave_body')}</p>
      <label>{t('own_reason_optional')}<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('cancel')}</button>
        <button type="button" className="btn danger" onClick={() => void leave()} disabled={busy}>{t('own_leave_cta')}</button>
      </div>
    </Sheet>
  );
}
