import { Flop } from '../../components/PlayingCard';
import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/ui';
import { amount, dateTime, multiplier } from '../../lib/format';
import { useT } from '../../i18n/i18n';
import { marketLabel, useDraws, type Coupon } from './data';

const STATUS_BADGE: Record<Coupon['status'], string> = { live: 'open', completed: 'live', voided: 'closed' };

/** One coupon: table, picks, d/n flops, committed, won, still riding. Tapping opens its draws. */
export function CouponCard({ coupon, onOpen }: { coupon: Coupon; onOpen: (id: string) => void }) {
  const t = useT();
  const done = Math.min(coupon.roundsSettled, coupon.rounds);
  return (
    <button type="button" className="card clickable me-coupon" style={{ textAlign: 'left' }} onClick={() => onOpen(coupon.id)}>
      <div className="row-between">
        <strong className="truncate">{coupon.tableName}</strong>
        <span className={`badge ${STATUS_BADGE[coupon.status]}`}>{t(`me_coupon_status_${coupon.status}`)}</span>
      </div>
      <div className="me-picks">
        {coupon.picks.map((p) => (
          <span key={p.market} className="pill" style={p.status === 'cancelled' ? { textDecoration: 'line-through' } : undefined}>
            {marketLabel(p.market)} {multiplier(p.multiplier)} · {amount(p.stakeCents, coupon.unit)}
          </span>
        ))}
      </div>
      <div className="row-between faint">
        <span>{t('me_coupon_flops', { done, total: coupon.rounds })}</span>
        <span>{dateTime(coupon.createdAt)}</span>
      </div>
      <div className="me-progress" aria-hidden><span style={{ width: `${(done / Math.max(1, coupon.rounds)) * 100}%` }} /></div>
      <div className="me-figures">
        <Figure label={t('me_committed')} value={amount(coupon.committedCents, coupon.unit)} />
        <Figure label={t('me_won')} value={amount(coupon.wonCents, coupon.unit)} tone={coupon.wonCents > 0 ? 'win' : undefined} />
        {coupon.status === 'live'
          ? <Figure label={t('me_still_riding')} value={amount(coupon.stillAtStakeCents, coupon.unit)} />
          : <Figure label={t('me_refunded')} value={amount(coupon.refundedCents, coupon.unit)} />}
      </div>
    </button>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'win' }) {
  return (
    <span className="me-figure">
      <span className="label">{label}</span>
      <span className={`value ${tone ?? ''}`}>{value}</span>
    </span>
  );
}

const PICK_CLASS: Record<string, string> = { won: 'win', lost: 'loss' };

/** Flop-by-flop results of one coupon (GET /player/coupon/:id/draws). */
export function DrawsSheet({ couponId, onClose }: { couponId: string | null; onClose: () => void }) {
  const t = useT();
  const draws = useDraws(couponId);
  const coupon = draws.data?.coupon;
  const upcoming = coupon && coupon.status === 'live' ? coupon.rounds - coupon.roundsSettled : 0;
  return (
    <Sheet open={Boolean(couponId)} onClose={onClose} title={coupon ? coupon.tableName : t('me_draws_title')}>
      {draws.isLoading && <Spinner />}
      {draws.isError && <div className="banner danger">{t('err_generic')}</div>}
      {coupon && (
        <div className="stack">
          <p className="muted">{t('me_draws_summary', { done: coupon.roundsSettled, total: coupon.rounds })}</p>
          {draws.data!.draws.length === 0 && <p className="faint">{t('me_draws_none')}</p>}
          {draws.data!.draws.map((d) => (
            <div key={d.handNumber} className="me-draw">
              <div className="row-between">
                <strong>{t('me_draws_hand', { n: d.handNumber })}</strong>
                <span className="faint">{t(`me_draw_status_${d.status}`)}</span>
              </div>
              {d.flop && <Flop cards={d.flop} size="sm" />}
              {d.picks.map((p) => (
                <div key={p.market} className="me-draw-pick">
                  <span>{marketLabel(p.market)} · {amount(p.stakeCents, coupon.unit)}</span>
                  <span className={PICK_CLASS[p.status] ?? 'faint'}>
                    {p.status === 'won' ? `+${amount(p.payoutCents, coupon.unit)}` : t(`me_pick_status_${p.status}`)}
                  </span>
                </div>
              ))}
              {d.status === 'cancelled' && <p className="faint">{t('me_draw_cancelled_note')}</p>}
            </div>
          ))}
          {upcoming > 0 && <p className="faint">{t('me_draws_upcoming', { n: upcoming })}</p>}
        </div>
      )}
    </Sheet>
  );
}
