import { Flop } from '../../components/PlayingCard';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { isLive, type Hand } from './api';

/** Result text of a hand: won X / no winners / cancelled / in play. */
export function handOutcome(hand: Hand, unit: string, t: (key: string, p?: Record<string, string | number>) => string): string {
  if (hand.status === 'cancelled') return t('dealer_hand_cancelled');
  if (isLive(hand)) return t('dealer_hand_in_play');
  return hand.winningBets > 0 ? t('dealer_hand_won', { amount: amount(hand.totalPaidOutCents, unit) }) : t('dealer_hand_no_winners');
}

export function RecentHands({ hands, unit }: { hands: readonly Hand[]; unit: string }) {
  const t = useT();
  if (hands.length === 0) return <p className="muted">{t('dealer_recent_empty')}</p>;
  return (
    <ul className="list recent-hands">
      {hands.map((h) => (
        <li key={h.id} className={`list-row hand-row ${h.status}`}>
          <span className="hand-no">#{h.handNumber}</span>
          <Flop cards={h.status === 'settled' ? h.flop : null} size="sm" />
          <span className="grow stack-xs">
            <span>{t('dealer_hand_picks', { n: h.totalBets })}</span>
            <span className="faint">{t('dealer_hand_played', { amount: amount(h.totalWageredCents, unit) })}</span>
          </span>
          <span className={`hand-outcome ${h.status === 'settled' && h.winningBets > 0 ? 'won' : ''}`}>{handOutcome(h, unit, t)}</span>
        </li>
      ))}
    </ul>
  );
}
