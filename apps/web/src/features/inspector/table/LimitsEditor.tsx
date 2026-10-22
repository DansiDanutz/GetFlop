import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useToast } from '../../../components/Toast';
import { useT } from '../../../i18n/i18n';
import { useMarketName } from '../reports/parts';
import { api } from '../../../lib/api';
import { multiplier } from '../../../lib/format';
import { INSP, type TableView } from '../api';
import { autoLimitCents, buildLimits, formFromLimits, fromCents, groupMarkets, toCents, type LimitsForm, type MarketInfo } from '../model/limits';

interface Props { table: TableView; markets: readonly MarketInfo[]; canEdit: boolean }

/** Min / max / coupon cap / max rounds and per-market limits; empty market = automatic "≤ n". */
export function LimitsEditor({ table, markets, canEdit }: Props) {
  const t = useT();
  const marketName = useMarketName();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<LimitsForm>(() => formFromLimits(table.limits));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setForm(formFromLimits(table.limits)); }, [table.limits]);
  const min = toCents(form.min) ?? table.limits.minCents;
  const max = toCents(form.max) ?? table.limits.maxCents;
  const field = (k: 'min' | 'max' | 'cap' | 'rounds') => (
    <label className="stack" key={k}>
      <span className="eyebrow">{t(`insp_limit_${k}`)}</span>
      <input inputMode={k === 'rounds' ? 'numeric' : 'decimal'} value={form[k]} disabled={!canEdit}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </label>
  );

  async function save() {
    const built = buildLimits(form);
    if (!built.ok) return toast.show(t(built.error), 'error');
    setBusy(true);
    try {
      await api.put(`/inspector/table/${table.id}/limits`, {
        minCents: built.value.minCents, maxCents: built.value.maxCents, couponCapCents: built.value.couponCapCents,
        maxRounds: built.value.maxRounds, marketMaxCents: built.value.marketMaxCents,
      });
      toast.show(t('insp_saved'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack">
      <span className="section-title">{t('insp_limits_title')}</span>
      {!canEdit && <div className="banner">{t('insp_limits_owner_only')}</div>}
      <div className="grid-2">{(['min', 'max', 'cap', 'rounds'] as const).map(field)}</div>
      <span className="eyebrow">{t('insp_limits_per_market')}</span>
      {groupMarkets(markets).map((g) => (
        <div key={g.group} className="stack">
          <span className="faint">{t(`insp_market_group_${g.group}`)}</span>
          {g.markets.map((m) => (
            <label key={m.slug} className="row insp-market">
              <span className="grow">{marketName(m.slug)} <span className="faint">{multiplier(m.multiplier)}</span></span>
              <input className="insp-limit-input" inputMode="decimal" disabled={!canEdit} value={form.markets[m.slug] ?? ''}
                placeholder={`≤ ${fromCents(autoLimitCents(m.multiplier, min, max))}`}
                onChange={(e) => setForm({ ...form, markets: { ...form.markets, [m.slug]: e.target.value } })} />
            </label>
          ))}
        </div>
      ))}
      {canEdit && <button type="button" className="btn primary block" disabled={busy} onClick={() => void save()}>{t('insp_save_limits')}</button>}
    </section>
  );
}
