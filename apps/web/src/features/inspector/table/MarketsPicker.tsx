import { useT } from '../../../i18n/i18n';
import { useMarketName } from '../reports/parts';
import { multiplier } from '../../../lib/format';
import { groupMarkets, type MarketInfo } from '../model/limits';

interface Props {
  markets: readonly MarketInfo[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}

/** Markets on/off grouped by category, with multipliers, Select all / Clear and "k/n". */
export function MarketsPicker({ markets, selected, onChange, disabled }: Props) {
  const t = useT();
  const marketName = useMarketName();
  const toggle = (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    onChange(next);
  };
  return (
    <div className="stack">
      <div className="row-between">
        <span className="muted">{t('insp_markets_count', { k: selected.size, n: markets.length })}</span>
        <span className="row">
          <button type="button" className="btn link" disabled={disabled} onClick={() => onChange(new Set(markets.map((m) => m.slug)))}>{t('insp_select_all')}</button>
          <button type="button" className="btn link" disabled={disabled} onClick={() => onChange(new Set())}>{t('insp_clear')}</button>
        </span>
      </div>
      {groupMarkets(markets).map((g) => (
        <div key={g.group} className="stack">
          <span className="eyebrow">{t(`insp_market_group_${g.group}`)}</span>
          {g.markets.map((m) => (
            <label key={m.slug} className="checkbox insp-market">
              <input type="checkbox" checked={selected.has(m.slug)} disabled={disabled} onChange={() => toggle(m.slug)} />
              <span className="grow">{marketName(m.slug)}</span>
              <strong className="num">{multiplier(m.multiplier)}</strong>
            </label>
          ))}
        </div>
      ))}
      {selected.size === 0 && <span className="field-error">{t('insp_market_required')}</span>}
    </div>
  );
}
