import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ConfirmSheet, Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { date, dateTime, points } from '../../lib/format';
import { useSession } from '../../state/session';
import { AccountBadges } from './Accounts';
import { AdminShell } from './AdminShell';
import { useAdmin, type AccountDetail as Detail, type AdminUser } from './api';
import { downloadCsv, toCsv } from './logic';
import { labelOr, Loadable, Pts, Section } from './parts';

const PICKS_SHORT = 20;

export function AccountDetailScreen() {
  const t = useT();
  const { id = '' } = useParams();
  const query = useAdmin<Detail>(['account', id], `/admin/players/${encodeURIComponent(id)}/detail`);
  return (
    <AdminShell>
      <Link to="/admin/accounts" className="muted">← {t('admin_accounts_title')}</Link>
      <Loadable query={query}>{(d) => <DetailBody d={d} />}</Loadable>
    </AdminShell>
  );
}

function DetailBody({ d }: { d: Detail }) {
  const t = useT();
  const a = d.account;
  return (
    <div className="stack-lg">
      <div className="stack">
        <div className="row-between"><h1 className="truncate">{a.displayName}</h1><span className="row"><AccountBadges account={a} /></span></div>
        <dl className="kv">
          <dt>{t('admin_username')}</dt><dd>@{a.username}</dd>
          <dt>{t('admin_status')}</dt><dd>{a.isActive ? t('admin_status_active') : t('admin_badge_deactivated')}</dd>
          <dt>{t('admin_type')}</dt><dd>{t(`admin_role_${a.role}`)}</dd>
          <dt>{t('admin_since')}</dt><dd>{date(a.createdAt)}</dd>
          <dt>{t('admin_last_seen')}</dt><dd>{a.lastSeenAt ? dateTime(a.lastSeenAt) : '—'}</dd>
          <dt>{t('admin_signs_in_with')}</dt><dd>{a.signsInWith.map((m) => t(`admin_signin_${m}`)).join(' · ')}</dd>
          <dt>{t('email')}</dt><dd>{a.email ?? '—'}{a.email && !a.emailVerified ? ` (${t('admin_email_unverified')})` : ''}</dd>
          <dt>{t('admin_devices_title')}</dt><dd>{d.devices.map((x) => labelOr(`admin_device_${x.device}`, x.device)).join(', ') || '—'}</dd>
        </dl>
      </div>
      <AccountActions account={a} />
      <ClubsBlock d={d} />
      <MovementsBlock d={d} />
      <PicksBlock d={d} />
    </div>
  );
}

function AccountActions({ account }: { account: AdminUser }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useSession();
  const [sheet, setSheet] = useState<'edit' | 'pin' | 'toggle' | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: account.username, displayName: account.displayName, newPin: '' });

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      toast.show(message, 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      setSheet(null);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const base = `/admin/users/${encodeURIComponent(account.id)}`;
  const edit = (e: FormEvent) => { e.preventDefault(); void run(() => api.put(base, { username: form.username, displayName: form.displayName }), t('admin_saved')); };
  const resetPin = (e: FormEvent) => { e.preventDefault(); void run(() => api.put(`${base}/reset-pin`, { newPin: form.newPin }), t('admin_pin_reset_done', { pin: form.newPin })); };
  const toggle = () => run(() => api.put(`${base}/toggle-active`, { active: !account.isActive }),
    account.isActive ? t('admin_deactivated_done') : t('admin_reactivated_done'));
  const isSelf = user?.id === account.id;

  return (
    <div className="grid-3">
      <button type="button" className="btn ghost" onClick={() => setSheet('edit')}>{t('edit')}</button>
      <button type="button" className="btn ghost" onClick={() => { setForm({ ...form, newPin: '' }); setSheet('pin'); }}>{t('admin_reset_pin')}</button>
      <button type="button" className={`btn ${account.isActive ? 'danger' : 'primary'}`} disabled={isSelf && account.isActive}
        onClick={() => setSheet('toggle')}>{account.isActive ? t('admin_deactivate') : t('admin_reactivate')}</button>

      <Sheet open={sheet === 'edit'} onClose={() => setSheet(null)} title={t('admin_edit_account')}>
        <form className="stack" onSubmit={edit}>
          <label>{t('username')}<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} maxLength={20} autoCapitalize="none" /></label>
          <label>{t('display_name')}<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={30} /></label>
          <button type="submit" className="btn primary" disabled={busy}>{t('save')}</button>
        </form>
      </Sheet>
      <Sheet open={sheet === 'pin'} onClose={() => setSheet(null)} title={t('admin_reset_pin')}>
        <form className="stack" onSubmit={resetPin}>
          <p className="muted">{t('admin_reset_pin_note')}</p>
          <label>{t('admin_new_pin')}<input value={form.newPin} onChange={(e) => setForm({ ...form, newPin: e.target.value })} inputMode="numeric" pattern="\d{4,8}" maxLength={8} required /></label>
          <button type="submit" className="btn primary" disabled={busy}>{t('admin_reset_pin')}</button>
        </form>
      </Sheet>
      <ConfirmSheet open={sheet === 'toggle'} busy={busy} danger={account.isActive}
        title={account.isActive ? t('admin_deactivate_title', { name: account.displayName }) : t('admin_reactivate_title', { name: account.displayName })}
        body={account.isActive ? t('admin_deactivate_body') : t('admin_reactivate_body')}
        confirmLabel={account.isActive ? t('admin_deactivate') : t('admin_reactivate')} cancelLabel={t('cancel')}
        onConfirm={() => void toggle()} onCancel={() => setSheet(null)} />
    </div>
  );
}

function ClubsBlock({ d }: { d: Detail }) {
  const t = useT();
  return (
    <Section title={t('admin_in_each_club')}>
      <p className="muted">{t('admin_in_each_club_note')}</p>
      {d.clubs.length === 0 && <p className="muted">{t('admin_no_club')}</p>}
      {d.clubs.map((c) => (
        <div key={c.clubId} className="card tight row-card">
          <div className="row-between"><strong>{c.name}</strong><span className="pill">{labelOr(`admin_membership_${c.statusLabel}`, c.status)}</span></div>
          <span className="meta">
            {t('admin_hands_n', { n: c.hands })} · {t('admin_balance')} <Pts cents={c.balanceCents} />
            {c.roles.length > 0 && ` · ${c.roles.map((r) => t(`role_${r}`)).join(', ')}`}
          </span>
          <span className="row">
            <a href={`#/club/card/${c.clubId}/${d.account.id}`}>{t('admin_member_card')}</a>
            <a href={`#/club/members/${c.clubId}`}>{t('admin_members_link')}</a>
          </span>
        </div>
      ))}
    </Section>
  );
}

function MovementsBlock({ d }: { d: Detail }) {
  const t = useT();
  const csv = () => downloadCsv(`movements-${d.account.username}.csv`, toCsv(
    ['date', 'club', 'kind', 'amount', 'balance_after', 'note'],
    d.movements.map((m) => [m.createdAt, m.clubName, m.kind, m.amountCents / 100, m.balanceAfterCents === null ? null : m.balanceAfterCents / 100, m.note]),
  ));
  return (
    <Section title={t('admin_movements')} action={d.movements.length > 0 && <button type="button" className="btn ghost" onClick={csv}>{t('admin_csv')}</button>}>
      {d.movements.length === 0 && <p className="muted">{t('admin_no_movements')}</p>}
      {d.movements.map((m) => (
        <div key={m.id} className="list-row">
          <span className="grow">
            <strong>{labelOr(`admin_ledger_${m.kind}`, m.kind)}</strong>
            <span className="muted" style={{ display: 'block' }}>{m.clubName} · {dateTime(m.createdAt)}{m.note ? ` · ${m.note}` : ''}</span>
          </span>
          <span style={{ textAlign: 'right' }}>
            <Pts cents={m.amountCents} sign />
            {m.balanceAfterCents !== null && <span className="faint" style={{ display: 'block' }}>{t('admin_balance_after')} {points(m.balanceAfterCents)}</span>}
          </span>
        </div>
      ))}
    </Section>
  );
}

function PicksBlock({ d }: { d: Detail }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const items = all ? d.picks.items : d.picks.items.slice(0, PICKS_SHORT);
  const csv = () => downloadCsv(`picks-${d.account.username}.csv`, toCsv(
    ['date', 'club', 'table', 'hand', 'market', 'stake', 'multiplier', 'status', 'payout', 'void_reason'],
    d.picks.items.map((p) => [p.createdAt, p.clubName, p.tableName, p.handNumber, p.market, p.stakeCents / 100, p.multiplier, p.status, p.payoutCents / 100, p.voidReason]),
  ));
  return (
    <Section title={t('admin_picks_title')} action={d.picks.total > 0 && <button type="button" className="btn ghost" onClick={csv}>{t('admin_csv')}</button>}>
      {d.picks.total === 0 && <p className="muted">{t('admin_no_picks')}</p>}
      {items.map((p) => (
        <div key={p.id} className="list-row">
          <span className="grow">
            <strong>{p.market}</strong> ×{p.multiplier}
            <span className="muted" style={{ display: 'block' }}>{p.clubName} · {p.tableName} · #{p.handNumber} · {dateTime(p.createdAt)}</span>
          </span>
          <span style={{ textAlign: 'right' }}>
            <Pts cents={p.stakeCents} />
            <span className="faint" style={{ display: 'block' }}>{labelOr(`admin_bet_${p.status}`, p.status)}{p.status === 'won' ? ` ${points(p.payoutCents)}` : ''}</span>
          </span>
        </div>
      ))}
      {d.picks.items.length > PICKS_SHORT && (
        <button type="button" className="btn ghost" onClick={() => setAll(!all)}>{all ? t('admin_show_fewer') : t('admin_all_picks', { n: d.picks.total })}</button>
      )}
    </Section>
  );
}
