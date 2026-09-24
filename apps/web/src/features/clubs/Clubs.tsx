import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { SURFACE_HOME, TopBar } from '../../components/TopBar';
import { Empty, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { useT } from '../../i18n/i18n';
import { useSession, type ClubContext } from '../../state/session';

export interface MyClub {
  id: string; publicId: string; name: string; description: string | null; photoUrl: string | null;
  level: string; membershipStatus: 'active' | 'pending'; roles: string[]; memberCount: number;
}

interface FoundClub {
  club: { id: string; publicId: string; name: string; description: string | null; photoUrl: string | null; memberCount: number };
  membershipStatus: string | null;
}

export function Clubs() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { selectClub } = useSession();
  const clubs = useQuery({ queryKey: ['clubs'], queryFn: () => api.get<{ clubs: MyClub[] }>('/clubs/mine') });
  const [findOpen, setFindOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  async function enter(club: MyClub) {
    if (club.membershipStatus !== 'active') return toast.show(t('clubs_pending_hint'));
    try {
      await selectClub(club.id);
      const ctx = await qc.fetchQuery({ queryKey: ['club-context', club.id], queryFn: () => api.get<ClubContext>('/clubs/context') });
      const staff = ctx.surfaces.find((s) => s === 'club' || s === 'inspector');
      navigate(SURFACE_HOME[staff ?? (ctx.surfaces.includes('dealer') && ctx.roles.length === 1 ? 'dealer' : 'player')]);
    } catch (err) { toast.error(err); }
  }

  return (
    <div className="screen">
      <TopBar />
      <div className="screen-body">
        <div className="row-between"><h1>{t('clubs_title')}</h1></div>
        {clubs.isLoading && <Spinner />}
        {clubs.data?.clubs.length === 0 && <Empty icon="♣" title={t('clubs_empty')}>{t('clubs_empty_sub')}</Empty>}
        <div className="stack">
          {clubs.data?.clubs.map((c) => (
            <button key={c.id} type="button" className="card clickable row" onClick={() => void enter(c)} style={{ textAlign: 'left' }}>
              <span className="club-chip" style={{ border: 0, padding: 0, background: 'none' }}>
                <span className="avatar" style={{ width: 52, height: 52 }}>{c.photoUrl ? <img src={c.photoUrl} alt="" /> : c.name[0]}</span>
              </span>
              <span className="grow">
                <strong style={{ display: 'block' }}>{c.name}</strong>
                <span className="muted">{t('clubs_id', { id: c.publicId })} · {t('clubs_members', { n: c.memberCount })}</span>
              </span>
              {c.membershipStatus === 'pending'
                ? <span className="badge open">{t('clubs_pending')}</span>
                : c.roles.length > 0 && <span className="pill">{c.roles.map((r) => t(`role_${r}`)).join(' · ')}</span>}
            </button>
          ))}
        </div>
        <div className="grid-2">
          <button type="button" className="btn primary" onClick={() => setFindOpen(true)}>{t('clubs_find')}</button>
          <button type="button" className="btn ghost" onClick={() => setCreateOpen(true)}>{t('clubs_create')}</button>
        </div>
      </div>
      <FindClubSheet open={findOpen} onClose={() => setFindOpen(false)} onJoined={() => void clubs.refetch()} />
      <CreateClubSheet open={createOpen} onClose={() => setCreateOpen(false)} onCreated={async (id) => {
        await qc.invalidateQueries({ queryKey: ['clubs'] });
        await selectClub(id);
        navigate('/club/tables');
      }} />
    </div>
  );
}

function FindClubSheet({ open, onClose, onJoined }: { open: boolean; onClose: () => void; onJoined: () => void }) {
  const t = useT();
  const toast = useToast();
  const [id, setId] = useState('');
  const [found, setFound] = useState<FoundClub | null>(null);
  async function search(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{7}$/.test(id)) return toast.show(t('err_club_id_invalid'), 'error');
    try { setFound(await api.get<FoundClub>(`/clubs/find/${id}`)); } catch (err) { setFound(null); toast.error(err); }
  }
  async function join() {
    if (!found) return;
    try {
      await api.post(`/clubs/${found.club.id}/join`, { source: 'club_id' });
      toast.show(t('clubs_request_sent', { club: found.club.name }), 'success');
      onJoined();
      onClose();
    } catch (err) { toast.error(err); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('clubs_find')}>
      <form className="row" onSubmit={search}>
        <input className="grow" inputMode="numeric" maxLength={7} placeholder={t('clubs_id_placeholder')} value={id} onChange={(e) => setId(e.target.value.replace(/\D/g, ''))} />
        <button className="btn primary">{t('search')}</button>
      </form>
      {found && (
        <div className="card stack">
          <strong>{found.club.name}</strong>
          {found.club.description && <p className="muted">{found.club.description}</p>}
          <span className="faint">{t('clubs_members', { n: found.club.memberCount })}</span>
          {found.membershipStatus === 'active' ? <div className="banner ok">{t('clubs_already_member')}</div>
            : found.membershipStatus === 'pending' ? <div className="banner">{t('err_club_request_pending')}</div>
            : <button type="button" className="btn primary block" onClick={() => void join()}>{t('clubs_request_join')}</button>}
        </div>
      )}
    </Sheet>
  );
}

function CreateClubSheet({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => Promise<void> }) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { club } = await api.post<{ club: { id: string } }>('/clubs', { name, description, acceptClubTerms: terms });
      onClose();
      await onCreated(club.id);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('clubs_create')}>
      <form className="stack" onSubmit={submit}>
        <label>{t('clubs_name')}<input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></label>
        <label>{t('clubs_description')}<textarea rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="checkbox"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />{t('clubs_accept_terms')}</label>
        <button className="btn primary block" disabled={busy || !terms || name.trim().length < 3}>{t('clubs_create')}</button>
      </form>
    </Sheet>
  );
}
