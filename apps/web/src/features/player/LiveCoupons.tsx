import type { ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import { amount, multiplier, signed } from '../../lib/format';
import { useTableCoupons } from './data';
import { marketKey } from './markets';
import type { CouponSummary } from './types';

const FINISHED_SHOWN = 3;

interface LiveCouponsProps {
  tableId: string;
  onSeeAll: (couponId: string) => void;
  onPlayAgain: (coupon: CouponSummary) => void;
  /** Hide the "finished here" list (used inside the slip's LIVE tab). */
  liveOnly?: boolean;
}

/** My coupons riding on this table, plus the last finished ones with Play again. */
export function LiveCoupons({ tableId, onSeeAll, onPlayAgain, liveOnly }: LiveCouponsProps) {
  const t = useT();
  const live = useTableCoupons(tableId, 'live').data?.coupons ?? [];
  const finished = useTableCoupons(tableId, 'completed').data?.coupons.slice(0, FINISHED_SHOWN) ?? [];

  return (
    <section className="stack">
      <h3 className="section-title">{t('player_live_title')}</h3>
      {live.length === 0 && <p className="muted">{t('player_live_empty')}</p>}
      <div className="pl-strip">
        {live.map((c) => <CouponCard key={c.id} coupon={c} onSeeAll={onSeeAll} />)}
      </div>
      {!liveOnly && finished.length > 0 && (
        <>
          <span className="eyebrow">{t('player_finished_title')}</span>
          <div className="pl-strip">
            {finished.map((c) => (
              <CouponCard key={c.id} coupon={c} onSeeAll={onSeeAll}
                action={<button type="button" className="btn outline-gold block" onClick={() => onPlayAgain(c)}>{t('player_play_again')}</button>} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

interface CouponCardProps {
  coupon: CouponSummary;
  onSeeAll: (couponId: string) => void;
  action?: ReactNode;
}

export function CouponCard({ coupon: c, onSeeAll, action }: CouponCardProps) {
  const t = useT();
  const left = c.rounds - c.roundsSettled;
  return (
    <article className="card tight stack pl-coupon">
      <div className="row-between">
        <span className="badge plain gold">{t('player_coupon_flops', { d: c.roundsSettled, n: c.rounds })}</span>
        {c.status !== 'live' && <strong className={c.wonCents - c.committedCents >= 0 ? 'win' : 'loss'}>{signed(c.wonCents - c.committedCents, c.unit)}</strong>}
      </div>
      <ul className="pl-picks">
        {c.picks.map((p) => (
          <li key={p.market}>{t(marketKey(p.market))} <span className="faint">{multiplier(p.multiplier)} · {amount(p.stakeCents, c.unit)}</span></li>
        ))}
      </ul>
      <div className="row-between faint">
        <span>{t('player_coupon_committed', { amount: amount(c.committedCents, c.unit) })}</span>
        <span>{t('player_coupon_won', { amount: amount(c.wonCents, c.unit) })}</span>
      </div>
      {c.status === 'live' && <span className="muted">{t('player_coupon_left', { n: left })}</span>}
      <button type="button" className="btn link" onClick={() => onSeeAll(c.id)}>{t('player_coupon_see_all', { n: c.rounds })}</button>
      {action}
    </article>
  );
}
