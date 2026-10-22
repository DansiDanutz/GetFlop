import { Flop } from '../../components/PlayingCard';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { points } from '../../lib/format';
import { useRecentHands } from './data';
import type { Unit } from './types';

/** RECENT HANDS: mini flop, hand number, picks and the outcome, Points played. */
export function RecentHands({ tableId, unit }: { tableId: string; unit: Unit }) {
  const t = useT();
  const q = useRecentHands(tableId);
  if (q.isLoading) return <Spinner />;
  const list = q.data?.hands ?? [];
  return (
    <section className="stack">
      <h3 className="section-title">{t('player_recent_title')}</h3>
      {list.length === 0 && <p className="muted">{t('player_recent_empty')}</p>}
      <div className="list card tight">
        {list.map((h) => (
          <div key={h.id} className="list-row pl-recent">
            {h.status === 'cancelled' ? <span className="pill">{t('player_recent_cancelled')}</span> : <Flop cards={h.flop} size="sm" />}
            <span className="grow">
              <strong style={{ display: 'block' }}>{t('player_recent_hand', { n: h.handNumber })}</strong>
              <span className="muted">
                {t('player_recent_picks', { n: h.totalBets })}
                {' · '}
                {h.status === 'cancelled' ? t('player_recent_refunded')
                  : h.winningBets === 0 ? t('player_recent_no_winners')
                  : t('player_recent_won', { amount: points(h.totalPaidOutCents) })}
              </span>
            </span>
            <span className="num right">
              <strong style={{ display: 'block' }}>{points(h.totalWageredCents)}</strong>
              <span className="faint">{t('player_recent_played', { unit: t(`unit_${unit}`) })}</span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
