import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { points } from '../../lib/format';
import { useSession } from '../../state/session';
import { StaffShell } from '../staff/StaffShell';
import { ownerApi } from './api';
import { DeleteClubSheet, LeaveClubSheet } from './EndClubSheets';
import { InviteSheet } from './InviteSheet';
import { Switch, ToggleRow } from './parts';
import { ProfileCard } from './ProfileCard';
import { RoomsCard } from './RoomsCard';
import { SetupCard } from './SetupCard';
import './owner.css';

/** Club tab (#/club/settings): first steps, profile, rooms, dealers, live, invite, Points, account, leave/delete (08 §4). */
export function ClubSettingsPage() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { context, refresh } = useSession();
  const clubId = context?.club.id ?? '';
  const isOwner = Boolean(context?.roles.includes('owner'));
  const settings = useQuery({ queryKey: ['owner', 'settings', clubId], queryFn: () => ownerApi.settings(clubId), enabled: Boolean(clubId) });
  const setup = useQuery({ queryKey: ['owner', 'setup', clubId], queryFn: () => ownerApi.setup(clubId), enabled: Boolean(clubId) });
  const [big, setBig] = useState('');
  const [sheet, setSheet] = useState<'invite' | 'delete' | 'leave' | null>(null);
  useEffect(() => { if (settings.data) setBig(points(settings.data.liveBigCents)); }, [settings.data]);

  async function save(body: { dealerSitApproval?: boolean; liveBigPoints?: string; boardEnabled?: boolean }) {
    try {
      qc.setQueryData(['owner', 'settings', clubId], await ownerApi.saveSettings(clubId, body));
      toast.show(t('own_saved'), 'success');
    } catch (err) { toast.error(err); }
  }

  const s = settings.data;
  return (
    <StaffShell dots={{ club: setup.data ? !setup.data.setup.complete : false }}>
      <h1>{t('own_club_title')}</h1>
      {setup.data && <SetupCard clubId={clubId} setup={setup.data.setup} />}
      {settings.isLoading && <Spinner />}
      {s && (
        <>
          <ProfileCard clubId={clubId} settings={s} />
          <section className="card stack">
            <h3>{t('own_invite_title')}</h3>
            <div className="row-between">
              <span className="muted">{t('own_club_id', { id: s.publicId })}</span>
              <button type="button" className="btn primary" onClick={() => setSheet('invite')}>{t('own_invite_open')}</button>
            </div>
          </section>
          <section className="card stack">
            <h3>{t('own_club_links')}</h3>
            <Link className="btn ghost block" to="/club/points">{t('own_points_title')}</Link>
            {isOwner && <Link className="btn ghost block" to="/club/account">{t('own_club_account')}</Link>}
            <Link className="btn ghost block" to="/club/setup">{t('own_all_steps')}</Link>
          </section>
          <RoomsCard clubId={clubId} rooms={s.rooms} />
          <section className="card">
            <ToggleRow title={t('own_dealer_approval')} note={t(s.dealerSitApproval ? 'own_dealer_approval_on' : 'own_dealer_approval_off')}>
              <Switch checked={s.dealerSitApproval} label={t('own_dealer_approval')} onChange={(on) => void save({ dealerSitApproval: on })} />
            </ToggleRow>
            <ToggleRow title={t('own_board')} note={t(s.boardEnabled ? 'own_board_on' : 'own_board_off')}>
              <Switch checked={s.boardEnabled} label={t('own_board')} onChange={(on) => void save({ boardEnabled: on })} />
            </ToggleRow>
          </section>
          <section className="card stack">
            <h3>{t('own_live_big')}</h3>
            <p className="own-note">{t('own_live_big_hint')}</p>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void save({ liveBigPoints: big }); }}>
              <input className="grow" inputMode="decimal" value={big} onChange={(e) => setBig(e.target.value)} aria-label={t('own_live_big')} />
              <button className="btn primary" disabled={big === points(s.liveBigCents)}>{t('save')}</button>
            </form>
          </section>
          <section className="card stack own-danger">
            {isOwner
              ? <button type="button" className="btn ghost block" onClick={() => setSheet('delete')}>{t('own_delete_title')}</button>
              : <button type="button" className="btn ghost block" onClick={() => setSheet('leave')}>{t('own_leave_cta')}</button>}
          </section>
          <InviteSheet open={sheet === 'invite'} onClose={() => setSheet(null)} clubId={clubId} />
          <DeleteClubSheet open={sheet === 'delete'} onClose={() => setSheet(null)} clubId={clubId} clubName={s.name} />
          <LeaveClubSheet open={sheet === 'leave'} onClose={() => { setSheet(null); void refresh(); }} clubId={clubId} clubName={s.name} />
        </>
      )}
    </StaffShell>
  );
}
