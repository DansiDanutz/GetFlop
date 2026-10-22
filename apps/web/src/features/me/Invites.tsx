import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { AuthShell } from '../auth/AuthShell';
import type { FoundClub } from './data';
import { clearInvite, readInvite, storeInvite } from './storage';

/** #/c/<ClubID> — stores the invite, then sends the user to sign in or to the clubs home. */
export function InviteLanding() {
  const t = useT();
  const { publicId = '' } = useParams();
  const { user, loading } = useSession();
  const [stored] = useState(() => storeInvite(publicId));
  if (!stored) {
    return (
      <AuthShell title={t('me_invite_invalid')}>
        <a className="btn primary block" href="#/login">{t('continue')}</a>
      </AuthShell>
    );
  }
  if (loading) return null;
  return <Navigate to={user ? '/clubs' : '/login'} replace />;
}

type InviteView = 'invite' | 'member' | 'pending' | 'invalid' | 'sent';

function viewFor(found: FoundClub | undefined, failed: boolean): InviteView | null {
  if (failed) return 'invalid';
  if (!found) return null;
  if (found.membershipStatus === 'active') return 'member';
  if (found.membershipStatus === 'pending') return 'pending';
  return 'invite';
}

/** On #/clubs: "You were invited to X — ask to join" (source invite), or the invite's state. */
export function PendingInviteBanner() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [invite, setInvite] = useState(() => readInvite());
  const [sent, setSent] = useState(false);
  const found = useQuery({
    queryKey: ['my', 'invite', invite?.publicId],
    queryFn: () => api.get<FoundClub>(`/clubs/find/${invite!.publicId}`),
    enabled: Boolean(invite),
    retry: false,
  });
  const failed = found.error instanceof ApiError && found.error.status < 500;
  const view: InviteView | null = sent ? 'sent' : viewFor(found.data, failed);
  useEffect(() => { if (view === 'member') clearInvite(); }, [view]);
  if (!invite || !view) return null;
  const dismiss = () => { clearInvite(); setInvite(null); };
  const club = found.data?.club.name ?? '';

  async function ask() {
    if (!found.data) return;
    try {
      await api.post(`/clubs/${found.data.club.id}/join`, { source: 'invite' });
      clearInvite();
      setSent(true);
      await qc.invalidateQueries({ queryKey: ['clubs'] });
    } catch (err) { toast.error(err); }
  }

  return (
    <div className={`banner ${view === 'invalid' ? 'danger' : view === 'invite' ? '' : 'ok'} stack`} role="status">
      <span>{t(`me_invite_${view}`, { club })}</span>
      <div className="row">
        {view === 'invite' && <button type="button" className="btn primary" onClick={() => void ask()}>{t('me_invite_ask')}</button>}
        <button type="button" className="btn ghost" onClick={dismiss}>{t(view === 'invite' ? 'me_invite_not_now' : 'close')}</button>
      </div>
    </div>
  );
}
