import { useState } from 'react';
import { Flop } from '../../components/PlayingCard';
import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { useCouponDraws } from './data';
import { marketKey } from './markets';
import type { CouponSummary, Draw } from './types';

interface CouponDrawsSheetProps {
  couponId: string | null;
  onClose: () => void;
  onPlayAgain?: (coupon: CouponSummary) => void;
}

/** Flop numbers per draw: cancelled hands use no flop, so they get no number. */
export function numberDraws(draws: readonly Draw[]): Array<{ draw: Draw; flopNumber: number | null }> {
  let n = 0;
  return draws.map((draw) => ({ draw, flopNumber: draw.status === 'cancelled' ? null : ++n }));
}

/** Flop-by-flop view of one coupon: the cards, and won / lost per pick. */
export function CouponDrawsSheet({ couponId, onClose, onPlayAgain }: CouponDrawsSheetProps) {
  const t = useT();
  const q = useCouponDraws(couponId);
  const [expanded, setExpanded] = useState<number | null>(null);
  const coupon = q.data?.coupon;
  const draws = numberDraws(q.data?.draws ?? []);
  const toCome = coupon ? coupon.rounds - coupon.roundsSettled - draws.filter((d) => d.draw.status === 'betting_open' || d.draw.status === 'betting_closed').length : 0;

  return (
    <Sheet open={Boolean(couponId)} onClose={onClose} title={t('player_draws_title')}>
      {q.isLoading && <Spinner />}
      {q.isError && <p className="banner danger">{t('player_draws_error')}</p>}
      {coupon && (
        <div className="stack">
          <div className="grid-3">
            <div><span className="faint">{t('player_draws_committed')}</span><strong style={{ display: 'block' }}>{amount(coupon.committedCents, coupon.unit)}</strong></div>
            <div><span className="faint">{t('player_draws_won')}</span><strong style={{ display: 'block' }}>{amount(coupon.wonCents, coupon.unit)}</strong></div>
            <div><span className="faint">{t('player_draws_at_stake')}</span><strong style={{ display: 'block' }}>{amount(coupon.stillAtStakeCents, coupon.unit)}</strong></div>
          </div>
          <span className="muted">{t('player_coupon_flops', { d: coupon.roundsSettled, n: coupon.rounds })} · {t(`player_coupon_status_${coupon.status}`)}</span>
          {draws.length > 0 && <span className="faint">{t('player_draws_tap')}</span>}
          <div className="list">
            {draws.map(({ draw, flopNumber }) => (
              <button key={draw.handNumber} type="button" className="list-row pl-draw" onClick={() => setExpanded(expanded === draw.handNumber ? null : draw.handNumber)}>
                <span className="stack" style={{ gap: 4, textAlign: 'left' }}>
                  <strong>{flopNumber === null ? t('player_draws_no_flop') : t('player_draws_flop', { k: flopNumber, n: coupon.rounds })}</strong>
                  <span className="faint">{t('player_recent_hand', { n: draw.handNumber })}</span>
                </span>
                <span className="grow">
                  {draw.status === 'cancelled' ? <span className="muted">{t('player_draws_cancelled')}</span>
                    : draw.flop ? <Flop cards={draw.flop} size={expanded === draw.handNumber ? 'md' : 'sm'} />
                    : <span className="badge open">{t('player_draws_in_play')}</span>}
                </span>
                <span className="stack" style={{ gap: 2, textAlign: 'right' }}>
                  {draw.status !== 'cancelled' && draw.picks.map((p) => (
                    <span key={p.market} className={p.status === 'won' ? 'win' : p.status === 'lost' ? 'loss' : 'faint'}>
                      {t(marketKey(p.market))} · {p.status === 'won' ? `+${amount(p.payoutCents, coupon.unit)}` : t(`player_pick_${p.status}`)}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {coupon.status === 'live' && toCome > 0 && <p className="muted">{t('player_coupon_left', { n: toCome })}</p>}
          {coupon.status !== 'live' && onPlayAgain && (
            <button type="button" className="btn outline-gold block" onClick={() => onPlayAgain(coupon)}>{t('player_play_again')}</button>
          )}
        </div>
      )}
    </Sheet>
  );
}
