import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ConfirmSheet, Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api, qs } from '../../lib/api';
import { AdminShell } from './AdminShell';
import { useAdmin, type AccountRow, type AccountsPage, type AdminUser } from './api';
import { Loadable } from './parts';

type Filter = 'all' | 'players' | 'admins' | 'inactive' | 'bots';
const FILTERS: readonly Filter[] = ['all', 'players', 'admins', 'inactive', 'bots'];
const PAGE = 50;

export function AccountBadges({ account }: { account: Pick<AdminUser, 'isAdmin' | 'isActive' | 'isBot'> }) {
  const t = useT();
  return (
    <>
      {account.isAdmin && <span className="badge gold plain">{t('admin_badge_admin')}</span>}
      {!account.isActive && <span className="badge closed plain">{t('admin_badge_deactivated')}</span>}
      {account.isBot && <span className="badge plain">{t('admin_badge_bot')}</span>}
    </>
  );
}

function AccountRowView({ a }: { a: AccountRow }) {
  const t = useT();
  return (
    <Link to={`/admin/account/${a.id}`} className="card tight row-card">
      <div className="row-between">
        <strong className="truncate">{a.displayName}</strong>
        <span className="row"><AccountBadges account={a} /></span>
      </div>
      <span className="meta">@{a.username}{a.email ? ` · ${a.email}` : ''}</span>
      <span className="meta">{a.clubs.length > 0 ? a.clubs.map((c) => c.name).join(', ') : t('admin_no_club')}</span>
    </Link>
  );
}

export function AccountsScreen() {
  const t = useT();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [creating, setCreating] = useState(false);
  const query = useAdmin<AccountsPage>(['accounts', filter, q, limit], `/admin/accounts${qs({ filter, q, limit })}`);
  const counts = query.data?.counts;

  function submit(e: FormEvent) {
    e.preventDefault();
    setQ(search.trim());
    setLimit(PAGE);
  }

  return (
    <AdminShell>
      <div className="row-between">
        <h1>{t('admin_accounts_title')}</h1>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>{t('admin_create_account')}</button>
      </div>
      <form onSubmit={submit} className="row">
        <input className="grow" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('admin_accounts_search')}
          aria-label={t('admin_accounts_search')} maxLength={100} />
        <button type="submit" className="btn ghost">{t('search')}</button>
      </form>
      <Segmented value={filter} onChange={(f) => { setFilter(f); setLimit(PAGE); }}
        options={FILTERS.map((f) => ({ value: f, label: `${t(`admin_filter_${f}`)}${counts ? ` ${counts[f]}` : ''}` }))} />
      <Loadable query={query} empty={(d) => d.accounts.length === 0}>
        {(d) => (
          <div className="stack">
            {d.accounts.map((a) => <AccountRowView key={a.id} a={a} />)}
            {d.total > d.accounts.length && (
              <button type="button" className="btn ghost" onClick={() => setLimit(limit + PAGE)}>
                {t('admin_show_more', { n: Math.min(PAGE, d.total - d.accounts.length) })}
              </button>
            )}
          </div>
        )}
      </Loadable>
      <CreateAccountSheet open={creating} onClose={() => setCreating(false)} />
    </AdminShell>
  );
}

function CreateAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: '', displayName: '', pin: '', role: 'player' as 'player' | 'admin' });
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const { user } = await api.post<{ user: AdminUser }>('/admin/users', form);
      toast.show(t('admin_created', { name: user.displayName }), 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      setConfirmAdmin(false);
      onClose();
      navigate(`/admin/account/${user.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (form.role === 'admin') setConfirmAdmin(true);
    else void create();
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('admin_create_account')}>
        <form className="stack" onSubmit={submit}>
          <label>{t('username')}<input value={form.username} onChange={set('username')} autoCapitalize="none" maxLength={20} required /></label>
          <label>{t('display_name')}<input value={form.displayName} onChange={set('displayName')} maxLength={30} /></label>
          <label>{t('pin')}<input value={form.pin} onChange={set('pin')} inputMode="numeric" pattern="\d{4,8}" maxLength={8} required /></label>
          <Segmented value={form.role} onChange={(role) => setForm({ ...form, role })}
            options={[{ value: 'player', label: t('admin_role_player') }, { value: 'admin', label: t('admin_role_admin') }]} />
          <p className="muted">{t('admin_create_note')}</p>
          <button type="submit" className="btn primary" disabled={busy}>{t('admin_create_account')}</button>
        </form>
      </Sheet>
      <ConfirmSheet open={confirmAdmin} title={t('admin_create_admin_title')} body={t('admin_create_admin_body', { name: form.username })}
        confirmLabel={t('admin_create_admin_confirm')} cancelLabel={t('cancel')} danger busy={busy}
        onConfirm={() => void create()} onCancel={() => setConfirmAdmin(false)} />
    </>
  );
}
