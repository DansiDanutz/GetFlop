import { CountdownRing } from '../../components/Countdown';
import { Flop } from '../../components/PlayingCard';
import { useT } from '../../i18n/i18n';
import { signed } from '../../lib/format';
import type { ArenaTable } from './api';
import { clockEndsAt, type HandResult } from './logic';

interface StageProps {
  table: ArenaTable;
  receivedAt: number;
  lastResult: HandResult | null;
}

const PHASE_KEY: Record<string, string> = {
  open: 'arena_phase_open', closing: 'arena_phase_closing', result: 'arena_phase_result', asleep: 'arena_phase_asleep',
};

/** Hand state, the three cards and the live ring. GetFlop deals here, not a person. */
export function Stage({ table, receivedAt, lastResult }: StageProps) {
  const t = useT();
  const clock = table.dealClock;
  const hand = table.currentHand ?? table.lastHand;
  const showCards = clock.phase === 'result' || clock.phase === 'asleep' ? table.lastHand?.flop : table.currentHand?.flop;
  const ringing = clock.phase === 'open' || clock.phase === 'closing';
  return (
    <section className="card arena-stage" aria-live="polite">
      <div className="row-between">
        <span className={`badge ${clock.phase === 'open' ? 'open' : clock.phase === 'closing' ? 'closed' : 'plain'}`}>{t(PHASE_KEY[clock.phase] ?? 'arena_phase_asleep')}</span>
        {hand && <span className="faint num">{t('arena_hand_no', { n: hand.handNumber })}</span>}
      </div>
      <Flop cards={showCards ?? null} size="md" />
      {ringing && <CountdownRing endsAt={clockEndsAt(clock, receivedAt)} totalSeconds={Math.round(clock.windowMs / 1000)} />}
      <p className="muted center arena-mascot">
        {clock.phase === 'asleep' ? t('arena_mascot_asleep') : clock.phase === 'open' ? t('arena_mascot_open') : t('arena_mascot_deals')}
      </p>
      {lastResult && clock.phase === 'result' && (
        <p className={`center num ${lastResult.netCents >= 0 ? 'win' : 'loss'}`}>{t('arena_net_result', { net: signed(lastResult.netCents, 'stars') })}</p>
      )}
    </section>
  );
}
