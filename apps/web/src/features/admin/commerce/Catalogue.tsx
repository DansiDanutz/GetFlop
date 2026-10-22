import { useState, type FormEvent } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { dateTime } from '../../../lib/format';
import { useAdmin } from '../api';
import { Loadable, useAdminAction } from '../parts';
import { productStates, versionPrice } from './logic';
import { COMMERCE_BASE, type Preview, type Product, type ProductKind, type Version } from './types';

const KINDS: readonly ProductKind[] = ['club_level', 'diamond_pack', 'turnover_rate', 'point_rate', 'usage_rate'];

function Price({ kind, v }: { kind: ProductKind; v: Version }) {
  const t = useT();
  const label = versionPrice(kind, v);
  return <>{label ? t(label.key, label.params) : '—'}</>;
}

export function CatalogueTab() {
  const t = useT();
  const query = useAdmin<{ products: Product[] }>(['commerce', 'catalogue'], `${COMMERCE_BASE}/catalogue`);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<{ product: Product; version: Version } | null>(null);
  return (
    <div className="stack">
      <button type="button" className="btn primary" onClick={() => setCreating(true)}>{t('admin_new_product')}</button>
      <Loadable query={query} empty={(d) => d.products.length === 0}>
        {(d) => (
          <div className="stack">
            {KINDS.map((kind) => {
              const list = d.products.filter((p) => p.kind === kind);
              if (list.length === 0) return null;
              return (
                <section key={kind} className="stack">
                  <h2 className="section-title">{t(`admin_kind_${kind}`)}</h2>
                  {list.map((p) => <ProductCard key={p.id} product={p} onEdit={(version) => setEditing({ product: p, version })} />)}
                </section>
              );
            })}
          </div>
        )}
      </Loadable>
      <NewProductSheet open={creating} onClose={() => setCreating(false)} />
      {editing && <DraftSheet product={editing.product} version={editing.version} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProductCard({ product, onEdit }: { product: Product; onEdit: (v: Version) => void }) {
  const t = useT();
  const { busy, run } = useAdminAction();
  const { inForce, scheduled, draft } = productStates(product);
  const setLifecycle = (lifecycle: string) => run(() => api.put(`${COMMERCE_BASE}/products/${product.id}`, { lifecycle }), t('admin_saved'));
  const newDraft = async () => {
    const res = await run(() => api.post<{ version: Version }>(`${COMMERCE_BASE}/products/${product.id}/drafts`));
    if (res) onEdit(res.version);
  };
  return (
    <div className="card tight row-card">
      <div className="row-between">
        <strong>{product.nameEn} <span className="faint">· {product.code}</span></strong>
        <select value={product.lifecycle} onChange={(e) => void setLifecycle(e.target.value)} disabled={busy} aria-label={t('admin_lifecycle')}>
          {(['draft', 'active', 'archived'] as const).map((l) => <option key={l} value={l}>{t(`admin_lifecycle_${l}`)}</option>)}
        </select>
      </div>
      <span className="meta">{inForce ? <>{t('admin_in_force', { v: inForce.version })} · <Price kind={product.kind} v={inForce} /></> : t('admin_nothing_in_force')}</span>
      {scheduled.map((s) => (
        <span key={s.id} className="meta">{t('admin_scheduled', { v: s.version, at: dateTime(s.effectiveFrom) })} · <Price kind={product.kind} v={s} />
          {' '}<button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => api.post(`${COMMERCE_BASE}/versions/${s.id}/withdraw`), t('admin_withdrawn'))}>{t('admin_withdraw')}</button>
        </span>
      ))}
      {draft
        ? <button type="button" className="btn ghost" onClick={() => onEdit(draft)}>{t('admin_draft_v', { v: draft.version })}</button>
        : <button type="button" className="btn ghost" disabled={busy} onClick={() => void newDraft()}>{t('admin_new_draft')}</button>}
    </div>
  );
}

function NewProductSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { busy, run } = useAdminAction();
  const [form, setForm] = useState({ code: '', kind: 'diamond_pack' as ProductKind, nameEn: '', nameEl: '' });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.post(`${COMMERCE_BASE}/products`, form), t('admin_saved'))) onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title={t('admin_new_product')}>
      <form className="stack" onSubmit={submit}>
        <label>{t('admin_product_code')}<input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} pattern="[a-z0-9_]{2,40}" required /></label>
        <label>{t('admin_product_kind')}
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProductKind })}>
            {KINDS.map((k) => <option key={k} value={k}>{t(`admin_kind_${k}`)}</option>)}
          </select>
        </label>
        <p className="muted">{t('admin_kind_note')}</p>
        <label>{t('admin_name_en')}<input value={form.nameEn} onChange={(e) => setForm({ ...form, nameEn: e.target.value })} maxLength={80} required /></label>
        <label>{t('admin_name_el')}<input value={form.nameEl} onChange={(e) => setForm({ ...form, nameEl: e.target.value })} maxLength={80} required /></label>
        <button type="submit" className="btn primary" disabled={busy}>{t('save')}</button>
      </form>
    </Sheet>
  );
}

const num = (text: string): number | null => (text.trim() === '' ? null : Number(text));
const str = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n));

function DraftSheet({ product, version, onClose }: { product: Product; version: Version; onClose: () => void }) {
  const t = useT();
  const { busy, run } = useAdminAction();
  const [f, setF] = useState({
    priceDiamonds: str(version.priceDiamonds), priceCents: str(version.priceCents), diamonds: str(version.diamonds),
    bonusPct: str(version.bonusPct), rateBp: str(version.rateBp), effectiveFrom: version.effectiveFrom?.slice(0, 16) ?? '', note: version.note ?? '',
    members: str(version.limits?.members), ringGames: str(version.limits?.ringGames), tournaments: str(version.limits?.tournaments),
    rooms: str(version.limits?.rooms), broadcasts: str(version.limits?.broadcasts),
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isLevel = product.kind === 'club_level';
  const isPack = product.kind === 'diamond_pack';
  const isRate = product.kind === 'turnover_rate';

  const body = () => ({
    priceDiamonds: isPack || isRate ? undefined : num(f.priceDiamonds),
    priceCents: isPack ? num(f.priceCents) : undefined,
    diamonds: isPack ? num(f.diamonds) : undefined,
    bonusPct: isPack ? num(f.bonusPct) : undefined,
    rateBp: isRate ? num(f.rateBp) : undefined,
    limits: isLevel ? {
      members: num(f.members) ?? 0, ringGames: num(f.ringGames) ?? 0, tournaments: num(f.tournaments) ?? 0,
      rooms: num(f.rooms) ?? 1, broadcasts: num(f.broadcasts),
    } : undefined,
    effectiveFrom: f.effectiveFrom ? new Date(f.effectiveFrom).toISOString() : null,
    note: f.note || null,
  });

  const save = () => run(() => api.put(`${COMMERCE_BASE}/versions/${version.id}`, body()), t('admin_saved'));
  const showPreview = async () => {
    if (!(await save())) return;
    const res = await run(() => api.get<{ preview: Preview }>(`${COMMERCE_BASE}/versions/${version.id}/preview`));
    if (res) setPreview(res.preview);
  };
  const publish = async () => { if (await run(() => api.post(`${COMMERCE_BASE}/versions/${version.id}/publish`), t('admin_published'))) onClose(); };
  const remove = async () => { if (await run(() => api.del(`${COMMERCE_BASE}/versions/${version.id}`), t('admin_deleted'))) onClose(); };
  const field = (k: keyof typeof f, label: string) => <label key={k}>{label}<input value={f[k]} onChange={set(k)} inputMode="numeric" /></label>;

  return (
    <Sheet open onClose={onClose} title={`${product.nameEn} · ${t('admin_draft_v', { v: version.version })}`}>
      {!preview && (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {!isPack && !isRate && field('priceDiamonds', t('admin_price_d'))}
          {isPack && <>{field('diamonds', t('admin_pack_diamonds'))}{field('priceCents', t('admin_price_cents'))}{field('bonusPct', t('admin_bonus_pct'))}</>}
          {isRate && field('rateBp', t('admin_rate_bp'))}
          {isLevel && <div className="grid-2">
            {field('members', t('admin_limit_members'))}{field('ringGames', t('admin_limit_ring_games'))}
            {field('tournaments', t('admin_limit_tournaments'))}{field('rooms', t('admin_limit_rooms'))}{field('broadcasts', t('admin_limit_broadcasts'))}
          </div>}
          <label>{t('admin_effective_from')}<input type="datetime-local" value={f.effectiveFrom} onChange={set('effectiveFrom')} /></label>
          <label>{t('admin_note')}<textarea value={f.note} onChange={set('note')} maxLength={500} /></label>
          <div className="grid-3">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void remove()}>{t('delete')}</button>
            <button type="submit" className="btn ghost" disabled={busy}>{t('save')}</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void showPreview()}>{t('admin_preview')}</button>
          </div>
        </form>
      )}
      {preview && <PreviewBody preview={preview} busy={busy} onBack={() => setPreview(null)} onPublish={() => void publish()} />}
    </Sheet>
  );
}

function PreviewBody({ preview, busy, onBack, onPublish }: { preview: Preview; busy: boolean; onBack: () => void; onPublish: () => void }) {
  const t = useT();
  const blocked = preview.noticeOk === false;
  return (
    <div className="stack">
      <p>{t('admin_preview_from', { at: dateTime(preview.from) })}</p>
      {preview.price && <p>{t('admin_preview_price', {
        from: preview.price.fromD ?? (preview.price.fromCents !== null && preview.price.fromCents !== undefined ? `€${(preview.price.fromCents / 100).toFixed(2)}` : '—'),
        to: preview.price.toD ?? (preview.price.toCents !== null && preview.price.toCents !== undefined ? `€${(preview.price.toCents / 100).toFixed(2)}` : '—'),
      })}</p>}
      {preview.rate && <p>{t('admin_preview_rate', { from: (preview.rate.fromBp ?? 0) / 100, to: (preview.rate.toBp ?? 0) / 100 })}</p>}
      {blocked && <div className="banner danger">{t('admin_preview_notice_short', { days: preview.minNoticeDays ?? 30 })}</div>}
      {preview.clubs !== undefined && <p>{t('admin_preview_clubs', { n: preview.clubs, at: preview.firstRenewalAt ? dateTime(preview.firstRenewalAt) : '—' })}</p>}
      {preview.limitsDiff?.map((l) => <p key={l.resource} className="muted">{t('admin_preview_limit', { resource: l.resource, from: l.from ?? '∞', to: l.to ?? '∞' })}</p>)}
      {preview.overLimit && preview.overLimit.length > 0 && <div className="banner danger">{t('admin_preview_over', { names: preview.overLimit.map((c) => c.name).join(', ') })}</div>}
      <p className="muted">{t('admin_preview_immutable')}</p>
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onBack} disabled={busy}>{t('back')}</button>
        <button type="button" className="btn primary" onClick={onPublish} disabled={busy || blocked}>{t('admin_publish')}</button>
      </div>
    </div>
  );
}
