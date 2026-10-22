import { useState } from 'react';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount, multiplier } from '../../lib/format';
import { FILTER_TABS, marketKey, marketsForTab, type FilterTab } from './markets';
import { marketMax, type SlipPick } from './slip';
import type { OfferedMarket, TableLimits, Unit } from './types';

interface MarketPickerProps {
  offered: readonly OfferedMarket[];
  limits: TableLimits;
  unit: Unit;
  picks: readonly SlipPick[];
  /** Markets that won on the last settled hand. */
  settledSlugs: readonly string[];
  disabled: boolean;
  onToggle: (slug: string) => void;
}

/** Filter tabs plus a grid of market chips (name, ×multiplier, max per pick). */
export function MarketPicker({ offered, limits, unit, picks, settledSlugs, disabled, onToggle }: MarketPickerProps) {
  const t = useT();
  const [tab, setTab] = useState<FilterTab>('popular');
  const list = marketsForTab(offered, tab);
  const picked = new Set(picks.map((p) => p.market));
  const won = new Set(settledSlugs);

  return (
    <section className="stack">
      <div className="row-between">
        <h3 className="section-title">{t('player_picker_title')}</h3>
        {picks.length === 0 && !disabled && <span className="faint">{t('player_picker_coach')}</span>}
      </div>
      <Segmented value={tab} onChange={setTab} options={FILTER_TABS.map((f) => ({ value: f, label: t(`player_tab_${f}`) }))} />
      {list.length === 0 && <p className="muted">{t('player_picker_empty')}</p>}
      <div className="markets">
        {list.map((m) => (
          <button
            key={m.slug} type="button" disabled={disabled} aria-pressed={picked.has(m.slug)}
            className={['market', picked.has(m.slug) ? 'on' : '', won.has(m.slug) ? 'won' : ''].filter(Boolean).join(' ')}
            onClick={() => onToggle(m.slug)}
          >
            <span className="m-name">{t(marketKey(m.slug))}</span>
            <span className="m-mult">{multiplier(m.multiplier)}</span>
            <span className="faint pl-mmax">{t('player_picker_max', { amount: amount(marketMax(m.slug, limits), unit) })}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
