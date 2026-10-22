import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { AuthShell } from '../auth/AuthShell';
import { tableHref, type TableCard } from './data';
import { clearTableJoin, isJoinCode, storeTableJoin } from './storage';

type JoinView = 'checking' | 'invalid' | 'closed' | 'signin' | 'member' | 'pending' | 'request' | 'sent';

export function joinView(card: TableCard | undefined, opts: { failed: boolean; signedIn: boolean; sent: boolean }): JoinView {
  if (opts.failed) return 'invalid';
  if (!card) return 'checking';
  if (card.table.status !== 'open') return 'closed';
  if (!opts.signedIn) return 'signin';
  if (opts.sent) return 'sent';
  if (card.membershipStatus === 'active') return 'member';
  if (card.membershipStatus === 'pending') return 'pending';
  return 'request';
}

/** #/join/<joinCode> — table QR: go to the table, or ask the table's club for access (source qr). */
export function JoinTable() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const { code = '' } = useParams();
  const { user, loading, selectClub } = useSession();
  const [sent, setSent] = useState(false);
  const entered = useRef(false);
  const valid = isJoinCode(code);
  const card = useQuery({
    queryKey: ['my', 'join', code, user?.id ?? null],
    queryFn: () => api.get<TableCard>(`/tables/by-code/${encodeURIComponent(code)}`),
    enabled: valid && !loading,
    retry: false,
  });
  const failed = !valid || (card.error instanceof ApiError && card.error.status < 500);
  const view = joinView(card.data, { failed, signedIn: Boolean(user), sent });
  const data = card.data;

  useEffect(() => {
    if (!data || view !== 'signin') return;
    storeTableJoin({ code, tableId: data.table.id, tableName: data.table.name, clubId: data.club.id, clubName: data.club.name });
  }, [view, data, code]);

  useEffect(() => {
    // A signed-in visit settles the pending join unless it still needs this page.
    if (user && ['invalid', 'closed', 'pending', 'sent'].includes(view)) clearTableJoin();
  }, [user, view]);

  useEffect(() => {
    if (view !== 'member' || !data || entered.current) return;
    entered.current = true;
    clearTableJoin();
    selectClub(data.club.id)
      .then(() => navigate(tableHref(data.table.id), { replace: true }))
      .catch((err: unknown) => { entered.current = false; toast.error(err); });
  }, [view, data, selectClub, navigate, toast]);

  async function request() {
    if (!data) return;
    try {
      await api.post(`/clubs/${data.club.id}/join`, { source: 'qr' });
      clearTableJoin();
      setSent(true);
    } catch (err) { toast.error(err); }
  }

  const names = { table: data?.table.name ?? '', club: data?.club.name ?? '', n: data?.table.activeHandNumber ?? '' };
  return (
    <AuthShell title={data ? data.table.name : t('me_join_title')}>
      {view === 'checking' && <Spinner />}
      {data && view !== 'invalid' && (
        <div className="card stack">
          <strong>{data.club.name}</strong>
          <span className="muted">{t('me_join_table_of', names)}</span>
          {data.table.activeHandStatus && <span className="badge open">{t('me_join_dealing', names)}</span>}
        </div>
      )}
      {view !== 'checking' && <div className={`banner ${view === 'invalid' || view === 'closed' ? 'danger' : ''}`} role="status">{t(`me_join_${view}`, names)}</div>}
      {view === 'signin' && (
        <div className="stack">
          <Link className="btn primary block" to="/login">{t('me_join_signin_cta')}</Link>
          <Link className="btn outline-gold block" to="/register">{t('register_new_player')}</Link>
        </div>
      )}
      {view === 'request' && <button type="button" className="btn primary block" onClick={() => void request()}>{t('me_join_request_cta')}</button>}
      {view === 'member' && <Spinner />}
      <Link className="center" to={user ? '/clubs' : '/login'}>{t('me_join_wrong_table')}</Link>
    </AuthShell>
  );
}
