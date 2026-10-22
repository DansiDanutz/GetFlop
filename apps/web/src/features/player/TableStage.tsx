import { CountdownRing } from '../../components/Countdown';
import { CardBack, Flop, PlayingCard } from '../../components/PlayingCard';
import { StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { points } from '../../lib/format';
import type { TablePhase } from './markets';
import type { HandStats, TableView } from './types';

/** Fallback countdown length when the server does not say (spec: 30 s). */
export const DEFAULT_TIMER_SECONDS = 30;

interface TableStageProps {
  table: TableView;
  stats: HandStats | undefined;
  phase: TablePhase;
  revealed: { handId: string; cards: readonly string[] } | null;
  timerSeconds: number | null;
  noMorePicks: boolean;
}

export const PHASE_KEY: Record<TablePhase, string> = {
  open: 'player_phase_open', closed: 'player_phase_closed', settled: 'player_phase_settled',
  cancelled: 'player_phase_cancelled', waiting: 'player_phase_waiting', table_closed: 'player_phase_table_closed',
};

/** Hand tiles, countdown ring and the flop (three backs, or the flop flipping face up). */
export function TableStage({ table, stats, phase, revealed, timerSeconds, noMorePicks }: TableStageProps) {
  const t = useT();
  const hand = table.currentHand;
  const handNumber = hand?.handNumber ?? stats?.hand?.handNumber ?? table.lastHandNumber;
  const total = timerSeconds || stats?.bettingTimerSeconds || DEFAULT_TIMER_SECONDS;
  const revealedHere = revealed && (!hand || revealed.handId === hand.id) ? revealed.cards : null;
  const settledFlop = phase === 'settled' ? table.lastHand?.flop ?? null : null;

  return (
    <section className="stack pl-stage" aria-label={t('player_stage')}>
      <div className="pl-tiles">
        <StatTile label={t('player_tile_hand')} value={handNumber > 0 ? `#${handNumber}` : '—'} />
        <StatTile label={t('player_tile_players')} value={stats?.players ?? 0} />
        <StatTile label={t('player_tile_picks')} value={stats?.picks ?? 0} />
        <StatTile label={t('player_tile_played', { unit: t(`unit_${table.unit}`) })} value={points(stats?.playedCents ?? 0)} />
      </div>
      <div className="pl-phase">
        <span className="eyebrow">{t(PHASE_KEY[phase])}</span>
        {phase === 'closed' && <span className="muted">{t('player_note_closed')}</span>}
        {phase === 'cancelled' && <span className="muted">{t('player_note_cancelled')}</span>}
        {phase === 'waiting' && <span className="muted">{t(table.dealerId || table.isAutoDeal ? 'player_note_preparing' : 'player_note_no_dealer')}</span>}
      </div>
      {phase === 'open' && hand?.bettingClosesAt && <CountdownRing endsAt={hand.bettingClosesAt} totalSeconds={total} />}
      {revealedHere ? (
        <div className="flop-row pl-reveal">
          {revealedHere.map((c) => <PlayingCard key={c} code={c} />)}
        </div>
      ) : settledFlop ? <Flop cards={settledFlop} /> : (
        <div className="flop-row">{[0, 1, 2].map((i) => <CardBack key={i} />)}</div>
      )}
      <p className="faint center">{t('player_three_cards')}</p>
      {noMorePicks && <div className="pl-nomore" role="alert">{t('player_no_more_picks')}</div>}
    </section>
  );
}
