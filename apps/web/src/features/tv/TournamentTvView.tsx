import { Flop } from '../../components/PlayingCard';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { LiveBadge } from './TvShell';
import type { TournamentTvData, TournamentTvRow } from './types';
import type { TvConnection } from './useTvSocket';

const STATUS_KEY: Record<string, string> = {
  active: 'tv_trm_live', running: 'tv_trm_live',
  finished: 'tv_trm_final', completed: 'tv_trm_final', cancelled: 'tv_trm_cancelled',
};
const isFinished = (status: string): boolean => status === 'finished' || status === 'completed';

function HandBox({ data, reveal }: { data: TournamentTvData; reveal: string[] | null }) {
  const t = useT();
  const hand = data.currentHand;
  const total = data.tournament.totalHands;
  const label = !hand ? t('tv_trm_not_started')
    : total ? t('tv_trm_hand_of', { n: hand.handNumber, total }) : t('tv_trm_hand', { n: hand.handNumber });
  const cards = reveal ?? (hand?.status === 'settled' ? hand.cards : null);
  return (
    <section className="tv-panel tv-trm-hand">
      <h2 className="tv-big num">{label}</h2>
      {hand && <div className="tv-trm-flop"><Flop cards={cards} size="md" /></div>}
      {hand?.status === 'settled' && !reveal && hand.winningMarkets.length > 0 && (
        <ul className="tv-chips">{hand.winningMarkets.map((m) => <li key={m.slug} className="tv-chip">{m.name}</li>)}</ul>
      )}
    </section>
  );
}

function LevelBox({ data }: { data: TournamentTvData }) {
  const t = useT();
  const { current, next, isFinal } = data.level;
  if (!current) return null;
  const max = current.maxBetChips < 0 ? t('tv_trm_no_limit') : amount(current.maxBetChips, 'chips');
  return (
    <section className="tv-panel tv-trm-level">
      <h2 className="tv-panel-title">{t('tv_trm_level', { n: current.levelNumber })}</h2>
      <dl className="tv-totals two">
        <div><dt>{t('tv_trm_min_pick')}</dt><dd className="num">{amount(current.minBetChips, 'chips')}</dd></div>
        <div><dt>{t('tv_trm_max_pick')}</dt><dd className="num">{max}</dd></div>
      </dl>
      <p className="muted">{t('tv_trm_ends_after', { n: current.endHand })}</p>
      {isFinal || !next ? <p className="tv-accent">{t('tv_trm_final_level')}</p> : (
        <p className="tv-accent">
          {t('tv_trm_next_level', { n: next.levelNumber })} · {amount(next.minBetChips, 'chips')} · {t('tv_trm_starts_at', { n: next.startHand })}
        </p>
      )}
    </section>
  );
}

function PrizeBox({ data }: { data: TournamentTvData }) {
  const t = useT();
  return (
    <section className="tv-panel tv-trm-prizes">
      <div className="row-between">
        <div>
          <h2 className="tv-panel-title">{t('tv_trm_prize_pool')}</h2>
          <p className="tv-big num">{amount(data.prizePoolCents)}</p>
          {data.guaranteed && <span className="badge gold plain">{t('tv_trm_gtd')}</span>}
        </div>
        <div className="tv-right">
          <h2 className="tv-panel-title">{t('tv_trm_players_left')}</h2>
          <p className="tv-big num">{t('tv_trm_players_left_of', { n: data.playersLeft, total: data.entrants })}</p>
        </div>
      </div>
      {data.payouts.length > 0 && (
        <ol className="tv-payouts">
          {data.payouts.map((p) => <li key={p.place}><span>{t('tv_trm_place', { n: p.place })}</span><span className="num">{amount(p.amountCents)}</span></li>)}
        </ol>
      )}
    </section>
  );
}

function Leaderboard({ rows, more }: { rows: TournamentTvRow[]; more: number }) {
  const t = useT();
  return (
    <section className="tv-panel tv-board">
      <h2 className="tv-panel-title">{t('tv_trm_leaderboard')}</h2>
      {rows.length === 0 ? <p className="muted tv-empty">{t('tv_trm_no_players')}</p> : (
        <ol className="tv-board-list" style={{ height: `calc(${rows.length} * var(--tv-row))` }}>
          {rows.map((r, i) => (
            <li key={r.name} className={`tv-board-row ${r.status}`} style={{ transform: `translateY(calc(${i} * var(--tv-row)))` }}>
              <span className="tv-rank num">{r.rank}</span>
              <span className="tv-name truncate">{r.name}</span>
              <span className="tv-chips-count num">{amount(r.chips, 'chips')}</span>
              <span className={`badge plain ${r.status === 'playing' ? 'live' : ''}`}>{t(r.status === 'playing' ? 'tv_trm_playing' : 'tv_trm_out')}</span>
              {r.payoutCents > 0 && <span className="tv-accent num">{amount(r.payoutCents)}</span>}
            </li>
          ))}
        </ol>
      )}
      {more > 0 && <p className="muted">{t('tv_trm_more', { n: more })}</p>}
    </section>
  );
}

interface Props {
  readonly data: TournamentTvData;
  readonly connection: TvConnection;
  readonly reveal: string[] | null;
}

/** Tournament TV: hand, level, prizes, players left and the leaderboard (names and chips are shown here). */
export function TournamentTvView({ data, connection, reveal }: Props) {
  const t = useT();
  const statusKey = STATUS_KEY[data.tournament.status] ?? 'tv_trm_upcoming';
  return (
    <>
      <header className="tv-head">
        <div className="grow">
          <span className="eyebrow">{t(statusKey)}</span>
          <h1 className="tv-title truncate">{data.tournament.name}</h1>
        </div>
        <LiveBadge connection={connection} />
      </header>
      {isFinished(data.tournament.status) && <p className="tv-banner">{t('tv_trm_finished')}</p>}
      <main className="tv-grid">
        <div className="tv-trm-left">
          <HandBox data={data} reveal={reveal} />
          <LevelBox data={data} />
          <PrizeBox data={data} />
        </div>
        <Leaderboard rows={data.leaderboard} more={data.more} />
      </main>
    </>
  );
}
