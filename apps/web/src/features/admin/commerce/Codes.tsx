import { useState, type FormEvent } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { date } from '../../../lib/format';
import { useAdmin } from '../api';
import { labelOr, Loadable, useAdminAction } from '../parts';
import { COMMERCE_BASE, type Product, type PromoCode } from './types';

export function CodesTab() {
  const t = useT();
  const toast = useToast();
  const query = useAdmin<{ codes: PromoCode[] }>(['commerce', 'codes'], `${COMMERCE_BASE}/promo-codes`);
  const { busy, run } = useAdminAction();
  const [creating, setCreating] = useState(false);
  const copy = (code: string) => {
    navigator.clipboard?.writeText(code).then(() => toast.show(t('copied')), () => toast.error(new Error('clipboard')));
  };
  return (
    <div className="stack">
      <button type="button" className="btn primary" onClick={() => setCreating(true)}>{t('admin_new_code')}</button>
      <Loadable query={query} empty={(d) => d.codes.length === 0}>
        {(d) => (
          <div className="stack">
            {d.codes.map((c) => (
              <div key={c.id} className="card tight row-card">
                <div className="row-between">
                  <strong className="mono">{c.code}</strong>
                  <span className="pill">{labelOr(`admin_code_status_${c.status}`, c.status)}</span>
                </div>
                <span className="meta">{c.kind === 'gift' ? t('admin_code_gift', { d: c.value }) : t('admin_code_percent', { pct: c.value })}{c.clubId ? '' : ` · ${t('admin_code_any_club')}`}</span>
                <span className="meta">{t('admin_code_uses', { used: c.redemptions.used, max: c.maxUses, at: date(c.expiresAt) })}</span>
                <span className="meta">{t('admin_code_redemptions', { used: c.redemptions.used, reserved: c.redemptions.reserved, released: c.redemptions.released })}</span>
                <div className="grid-2">
                  <button type="button" className="btn ghost" onClick={() => copy(c.code)}>{t('copy')}</button>
                  <button type="button" className="btn ghost" disabled={busy || c.status === 'withdrawn'}
                    onClick={() => void run(() => api.post(`${COMMERCE_BASE}/promo-codes/${c.id}/disable`), t('admin_withdrawn'))}>{t('admin_withdraw')}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Loadable>
      <NewCodeSheet open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewCodeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { busy, run } = useAdminAction();
  const catalogue = useAdmin<{ products: Product[] }>(['commerce', 'catalogue'], `${COMMERCE_BASE}/catalogue`, open);
  const packs = (catalogue.data?.products ?? []).filter((p) => p.kind === 'diamond_pack');
  const clubs = useAdmin<{ clubs: { id: string; name: string; publicId: string }[] }>(['commerce', 'clubs'], `${COMMERCE_BASE}/clubs`, open);
  const [f, setF] = useState({ code: '', kind: 'gift' as 'gift' | 'percent', value: '', packId: '', clubId: '', days: '30', uses: '1' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await run(() => api.post<{ code: PromoCode }>(`${COMMERCE_BASE}/promo-codes`, {
      code: f.code.trim() || null, kind: f.kind, value: Number(f.value), packId: f.kind === 'percent' && f.packId ? f.packId : null,
      clubId: f.clubId.trim() || null, days: Number(f.days), uses: Number(f.uses),
    }), (r) => t('admin_code_created', { code: r.code.code }));
    if (res) {
      void navigator.clipboard?.writeText(res.code.code).catch(() => undefined);
      onClose();
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('admin_new_code')}>
      <form className="stack" onSubmit={submit}>
        <label>{t('admin_code')}<input value={f.code} onChange={set('code')} placeholder={t('admin_code_blank')} maxLength={24} /></label>
        <label>{t('admin_code_kind')}
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as 'gift' | 'percent' })}>
            <option value="gift">{t('admin_code_kind_gift')}</option>
            <option value="percent">{t('admin_code_kind_percent')}</option>
          </select>
        </label>
        <label>{f.kind === 'gift' ? t('admin_code_value_d') : t('admin_code_value_pct')}<input value={f.value} onChange={set('value')} inputMode="numeric" required /></label>
        {f.kind === 'percent' && (
          <label>{t('admin_code_pack')}
            <select value={f.packId} onChange={set('packId')}>
              <option value="">{t('admin_code_any_pack')}</option>
              {packs.map((p) => <option key={p.id} value={p.id}>{p.nameEn}</option>)}
            </select>
          </label>
        )}
        <label>{t('admin_code_club')}
          <select value={f.clubId} onChange={set('clubId')}>
            <option value="">{t('admin_code_any_club')}</option>
            {(clubs.data?.clubs ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} · {c.publicId}</option>)}
          </select>
        </label>
        {!f.clubId.trim() && <p className="muted">{t('admin_code_no_owner')}</p>}
        <div className="grid-2">
          <label>{t('admin_code_days')}<input value={f.days} onChange={set('days')} inputMode="numeric" required /></label>
          <label>{t('admin_code_max_uses')}<input value={f.uses} onChange={set('uses')} inputMode="numeric" required /></label>
        </div>
        <button type="submit" className="btn primary" disabled={busy}>{t('admin_create_code')}</button>
      </form>
    </Sheet>
  );
}
