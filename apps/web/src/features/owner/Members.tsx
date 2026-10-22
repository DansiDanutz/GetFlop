import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { ago, amount, date } from '../../lib/format';
import { useSocketEvent } from '../../lib/socket';
import { StaffShell } from '../staff/StaffShell';
import { ownerApi, type JoinRequest, type MemberFilter, type MemberRow } from './api';
import { Avatar, RoleBadges } from './parts';
import { useStaffClub } from './useStaffClub';
import './owner.css';

const FILTERS: readonly MemberFilter[] = ['all', 'players', 'staff', 'owner', 'manager', 'inspector', 'dealer', 'pending', 'ended'];

const isFilter = (v: string | null): v is MemberFilter => FILTERS.includes(v as MemberFilter);

/** Members tab (#/club/members): search, filters, join requests, member rows (08 §2). */
export function Members() {
  const t = useT();
  const { clubId, base } = useStaffClub();
  const [params, setParams] = useSearchParams();
  const filter: MemberFilter = isFilter(params.get('filter')) ? (params.get('filter') as MemberFilter) : 'all';
  const [q, setQ] = useState('');
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['owner', 'members', clubId, filter, q.trim()],
    queryFn: () => ownerApi.members(clubId!, filter, q.trim()),
    enabled: Boolean(clubId),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['owner'] });
  useSocketEvent('members:changed', refresh, [qc]);
  useSocketEvent('request:new', refresh, [qc]);
  useSocketEvent('request:resolved', refresh, [qc]);
  const setFilter = (f: MemberFilter) => setParams(f === 'all' ? {} : { filter: f }, { replace: true });
  const counts = list.data?.counts;

  return (
    <StaffShell dots={{ members: Boolean(counts?.pending) }}>
      <div className="row-between">
        <h1>{t('own_members_title')}</h1>
        <Link className="btn ghost" to="/club/scan">{t('own_scan_qr')}</Link>
      </div>
      <p className="muted">{t('own_members_hint')}</p>
      {counts && (
        <div className="row-between">
          <span className="muted">{t('own_members_total', { n: counts.active })}</span>
          {counts.pending > 0 && (
            <button type="button" className="btn link" onClick={() => setFilter('pending')}>{t('own_join_waiting', { n: counts.pending })}</button>
          )}
        </div>
      )}
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('own_search_placeholder')} aria-label={t('own_search_placeholder')} />
      <div className="own-chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={f === filter} className={`chip${f === filter ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {t(`own_filter_${f}`)}
          </button>
        ))}
      </div>
      {filter === 'pending' && clubId && <JoinRequests clubId={clubId} />}
      {list.isLoading && <Spinner />}
      {list.data && filter !== 'pending' && (
        list.data.members.length === 0
          ? <Empty title={t('own_members_empty')} />
          : <div className="card tight">{list.data.members.map((m) => <MemberLine key={m.userId} m={m} me={list.data.actor.userId} to={base.card(m.userId)} />)}</div>
      )}
    </StaffShell>
  );
}

function MemberLine({ m, me, to }: { m: MemberRow; me: string; to: string }) {
  const t = useT();
  const navigate = useNavigate();
  const ended = m.status === 'left' || m.status === 'removed';
  return (
    <button type="button" className="own-row" onClick={() => !ended && navigate(to)} disabled={ended} style={{ cursor: ended ? 'default' : 'pointer' }}>
      <Avatar name={m.displayName} />
      <span className="grow" style={{ minWidth: 0 }}>
        <strong className="truncate" style={{ display: 'block' }}>{m.displayName}{m.userId === me && <span className="faint"> · {t('own_you')}</span>}</strong>
        <span className="faint">@{m.username}</span>
        {ended
          ? <span className="own-note" style={{ display: 'block' }}>{endedLine(m, t)}</span>
          : <RoleBadges roles={m.roles} watch={m.playMode === 'watch'} />}
      </span>
      {!ended && (
        <span style={{ textAlign: 'right' }}>
          {m.balanceCents !== undefined && <span className="own-amount" style={{ display: 'block' }}>{amount(m.balanceCents)}</span>}
          {m.lastPlayedAt && <span className="own-note">{t('own_last_played', { ago: ago(m.lastPlayedAt) })}</span>}
        </span>
      )}
    </button>
  );
}

function endedLine(m: MemberRow, t: ReturnType<typeof useT>): string {
  const when = date(m.endedAt);
  if (m.status === 'left') return t('own_ended_left', { date: when });
  return m.endedBy ? t('own_ended_removed_by', { date: when, name: m.endedBy.name }) : t('own_ended_removed', { date: when });
}

/** Join requests waiting, with approve / reject (also shown in Requests). */
function JoinRequests({ clubId }: { clubId: string }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const requests = useQuery({ queryKey: ['owner', 'join-requests', clubId], queryFn: () => ownerApi.joinRequests(clubId) });
  async function decide(r: JoinRequest, decision: 'approve' | 'reject') {
    setBusy(r.membershipId);
    try {
      await ownerApi.reviewJoin(clubId, r.membershipId, decision);
      toast.show(t(decision === 'approve' ? 'own_join_approved' : 'own_join_rejected', { name: r.displayName ?? r.username }), 'success');
      await qc.invalidateQueries({ queryKey: ['owner'] });
    } catch (err) { toast.error(err); } finally { setBusy(null); }
  }
  if (requests.isLoading) return <Spinner />;
  const list = requests.data?.requests ?? [];
  if (list.length === 0) return <Empty title={t('own_join_none')} />;
  return (
    <div className="card tight">
      {list.map((r) => (
        <div key={r.membershipId} className="own-row" style={{ cursor: 'default' }}>
          <Avatar name={r.displayName ?? r.username} />
          <span className="grow" style={{ minWidth: 0 }}>
            <strong className="truncate" style={{ display: 'block' }}>{r.displayName ?? r.username}</strong>
            <span className="faint">@{r.username} · {t(`own_source_${r.via}`)} · {ago(r.createdAt)}</span>
            {r.playMode === 'watch' && <span className="own-note" style={{ display: 'block' }}>{t('own_join_was_watch')}</span>}
          </span>
          <button type="button" className="btn ghost" disabled={busy === r.membershipId} onClick={() => void decide(r, 'reject')}>{t('own_reject')}</button>
          <button type="button" className="btn go" disabled={busy === r.membershipId} onClick={() => void decide(r, 'approve')}>{t('own_approve')}</button>
        </div>
      ))}
    </div>
  );
}
