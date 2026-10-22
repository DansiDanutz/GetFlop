import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import type { Coupon } from './api';
import { marketName } from './MarketPicker';

/** Coupons still riding on the Arena table. */
export function LiveCoupons({ coupons }: { coupons: Coupon[] }) {
  const t = useT();
  return (
    <section className="stack">
      <span className="section-title">{t('arena_live_title')}</span>
      {coupons.length === 0 && <p className="muted">{t('arena_live_none')}</p>}
      <div className="list">
        {coupons.map((c) => (
          <div key={c.id} className="list-row">
            <span className="grow">
              <span className="truncate" style={{ display: 'block' }}>{c.picks.map((p) => marketName(t, p.market)).join(' · ')}</span>
              <span className="faint">{t('arena_live_progress', { k: c.roundsSettled, n: c.rounds, left: c.rounds - c.roundsSettled })}</span>
            </span>
            <span className="num" style={{ textAlign: 'right' }}>
              <span style={{ display: 'block' }}>{t('arena_live_committed', { x: amount(c.committedCents, 'stars') })}</span>
              <span className="win">{t('arena_live_won', { x: amount(c.wonCents, 'stars') })}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
