import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { useSession } from '../../../state/session';
import { INSP, useCatalogue, useDealers, type TableView } from '../api';
import { selectionPayload, toCents } from '../model/limits';
import { DealerSheet } from './DealerSheet';
import { MarketsPicker } from './MarketsPicker';

const DEFAULTS = { min: '1', max: '50', cap: '200' };

/** New table (07 §2.1): name, markets, and limits for owner or manager. Created closed. */
export function CreateTableSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useSession();
  const catalogue = useCatalogue();
  const dealers = useDealers(open);
  const markets = catalogue.data ?? [];
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limits, setLimits] = useState(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [selfDeal, setSelfDeal] = useState(false);
  const canLimits = can('limits.edit');

  useEffect(() => {
    if (open) { setName(''); setLimits(DEFAULTS); setCreated(null); }
  }, [open]);
  useEffect(() => { setSelected(new Set(markets.map((m) => m.slug))); }, [markets]);

  async function submit() {
    if (!name.trim() || selected.size === 0) return;
    const body: Record<string, unknown> = { name: name.trim(), allowedBetTypeIds: selectionPayload(selected, markets) };
    if (canLimits) {
      const [min, max, cap] = [toCents(limits.min), toCents(limits.max), toCents(limits.cap)];
      if (min === null || max === null || cap === null) return toast.show(t('insp_limits_invalid'), 'error');
      Object.assign(body, { minBetCents: min, maxBetCents: max, maxCouponCommitmentCents: cap });
    }
    setBusy(true);
    try {
      const { table } = await api.post<{ table: TableView }>('/inspector/table', body);
      toast.show(t('insp_toast_created', { table: table.name }), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      if ((dealers.data ?? []).length === 0) setCreated({ id: table.id, name: table.name });
      else onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <>
        <Sheet open={open && !selfDeal} onClose={onClose} title={t('insp_no_dealer_yet')}>
          <p className="muted">{t('insp_no_dealer_yet_body')}</p>
          {can('members.manage') && <button type="button" className="btn ghost block" onClick={() => { onClose(); navigate('/club/members'); }}>{t('insp_open_members')}</button>}
          {can('settings') && <button type="button" className="btn primary block" onClick={() => setSelfDeal(true)}>{t('insp_deal_myself')}</button>}
        </Sheet>
        <DealerSheet open={open && selfDeal} mode="open" table={created} onClose={() => { setSelfDeal(false); onClose(); }} />
      </>
    );
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('insp_new_table')}>
      <label className="stack">
        <span className="eyebrow">{t('insp_table_name')}</span>
        <input value={name} maxLength={40} placeholder={t('insp_table_name_ph')} onChange={(e) => setName(e.target.value)} />
      </label>
      {canLimits && (
        <div className="grid-3">
          {(['min', 'max', 'cap'] as const).map((k) => (
            <label key={k} className="stack">
              <span className="eyebrow">{t(`insp_limit_${k}`)}</span>
              <input inputMode="decimal" value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </label>
          ))}
        </div>
      )}
      <span className="eyebrow">{t('insp_allowed_markets')}</span>
      <MarketsPicker markets={markets} selected={selected} onChange={setSelected} />
      <button type="button" className="btn primary block" disabled={busy || !name.trim() || selected.size === 0} onClick={() => void submit()}>
        {t('insp_create')}
      </button>
    </Sheet>
  );
}
