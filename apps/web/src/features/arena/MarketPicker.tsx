import { useState } from 'react';
import { Segmented } from '../../components/ui';
import { hasKey, useT, type t as translate } from '../../i18n/i18n';
import { multiplier } from '../../lib/format';
import type { Market } from './api';

const GROUPS = ['popular', 'pairs', 'flushes', 'runs', 'specials', 'all'] as const;
type Group = (typeof GROUPS)[number];

/** Translated market name (falls back to the catalogue name). */
export function marketName(t: typeof translate, slug: string, fallback = slug): string {
  const key = `arena_mkt_${slug}`;
  return hasKey(key) ? t(key) : fallback;
}

interface MarketPickerProps {
  markets: Market[];
  selected: readonly string[];
  onToggle: (slug: string) => void;
  winning?: readonly string[];
}

/** Filter tabs, then tiles sorted by price; tap to add to or remove from the slip. */
export function MarketPicker({ markets, selected, onToggle, winning = [] }: MarketPickerProps) {
  const t = useT();
  const [group, setGroup] = useState<Group>('popular');
  const shown = markets.filter((m) => group === 'all' || m.group === group).sort((a, b) => a.multiplier - b.multiplier);
  return (
    <section className="stack">
      <Segmented value={group} onChange={setGroup} options={GROUPS.map((g) => ({ value: g, label: t(`arena_group_${g}`) }))} />
      <p className="faint">{t('arena_tap_many')}</p>
      <div className="markets">
        {shown.map((m) => {
          const on = selected.includes(m.slug);
          return (
            <button key={m.slug} type="button" aria-pressed={on}
              className={`market ${on ? 'on' : ''} ${winning.includes(m.slug) ? 'won' : ''}`} onClick={() => onToggle(m.slug)}>
              <span className="m-name">{marketName(t, m.slug, m.name)}</span>
              <span className="m-mult">{multiplier(m.multiplier)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
