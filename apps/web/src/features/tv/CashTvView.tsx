import { useEffect, useState } from 'react';
import { CardBack, Flop } from '../../components/PlayingCard';
import { QrCode } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { mmss, secondsUntil, toLocal } from './clock';
import { LiveBadge } from './TvShell';
import type { CashTvData, TvHand } from './types';
import type { TvConnection } from './useTvSocket';

const TICK_MS = 250;
const MINUTE_S = 60;

function Countdown({ endsAt }: { endsAt: Date }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const left = secondsUntil(endsAt, now);
  return (
    <div className={`tv-countdown ${left <= 5 ? 'urgent' : ''}`} role="timer">
      <span className="tv-label">{t('tv_next_flop_in')}</span>
      <span className="tv-countdown-value num">{left >= MINUTE_S ? mmss(left) : t('tv_seconds', { n: left })}</span>
    </div>
  );
}

function PopularMarkets({ markets }: { markets: CashTvData['markets'] }) {
  const t = useT();
  const top = markets[0]?.picks ?? 0;
  return (
    <section className="tv-panel">
      <h2 className="tv-panel-title">{t('tv_popular')}</h2>
      {markets.length === 0 ? <p className="muted tv-empty">{t('tv_popular_empty')}</p> : (
        <ol className="tv-bars">
          {markets.map((m) => (
            <li key={m.slug}>
              <span className="tv-bar-name">{m.name}</span>
              <span className="tv-bar-track"><span className="tv-bar-fill" style={{ width: `${top ? (m.picks / top) * 100 : 0}%` }} /></span>
              <span className="tv-bar-count num">{t('tv_picks_count', { n: m.picks })}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Totals({ hand }: { hand: TvHand }) {
  const t = useT();
  const items: [string, string | number][] = [
    ['tv_totals_players', hand.players], ['tv_totals_picks', hand.bets], ['tv_totals_played', amount(hand.stakedCents)],
    ['tv_totals_won', amount(hand.paidOutCents)], ['tv_totals_winners', hand.winners],
  ];
  return (
    <dl className="tv-totals">
      {items.map(([key, value]) => (
        <div key={key}><dt>{t(key)}</dt><dd className="num">{value}</dd></div>
      ))}
    </dl>
  );
}

function Stage({ data, reveal, offsetMs }: { data: CashTvData; reveal: string[] | null; offsetMs: number }) {
  const t = useT();
  const { hand } = data;
  if (data.table.status !== 'open') {
    return <div className="tv-stage tv-center"><h1 className="tv-huge">{t('tv_off_air')}</h1><p className="muted">{t('tv_off_air_sub')}</p></div>;
  }
  if (reveal) {
    return <div className="tv-stage"><div className="tv-flop reveal"><Flop cards={reveal} /></div></div>;
  }
  if (!hand || hand.status === 'cancelled') {
    return <div className="tv-stage tv-center"><h1 className="tv-big">{t('tv_waiting')}</h1></div>;
  }
  const head = <p className="eyebrow tv-hand-no">{t('tv_hand', { n: hand.handNumber })}</p>;
  if (hand.status === 'betting_open') {
    const endsAt = toLocal(hand.bettingClosesAt, offsetMs);
    return (
      <div className="tv-stage tv-open">
        <div className="tv-open-head">{head}<h1 className="tv-big">{t('tv_picks_open')}</h1>{endsAt && <Countdown endsAt={endsAt} />}</div>
        <PopularMarkets markets={data.markets} />
      </div>
    );
  }
  if (hand.status === 'betting_closed') {
    return (
      <div className="tv-stage tv-center">
        {head}
        <div className="tv-flop"><div className="flop-row"><CardBack /><CardBack /><CardBack /></div></div>
        <h1 className="tv-big">{t('tv_flop_coming')}</h1>
        <p className="muted">{t('tv_picks_locked')}</p>
      </div>
    );
  }
  return (
    <div className="tv-stage tv-result">
      {head}
      <div className="tv-flop"><Flop cards={hand.cards} /></div>
      <div className="tv-hits">
        <h2 className="tv-panel-title">{t('tv_markets_hit')}</h2>
        {hand.winningMarkets.length === 0 ? <p className="muted">{t('tv_no_market_hit')}</p> : (
          <ul className="tv-chips">{hand.winningMarkets.map((m) => <li key={m.slug} className="tv-chip">{m.name}</li>)}</ul>
        )}
      </div>
      <Totals hand={hand} />
    </div>
  );
}

function Side({ data }: { data: CashTvData }) {
  const t = useT();
  return (
    <aside className="tv-side">
      <section className="tv-panel tv-join">
        <h2 className="tv-panel-title">{t('tv_join_title')}</h2>
        {data.table.joinUrl ? (
          <>
            <QrCode text={data.table.joinUrl} size={220} />
            <p className="muted num">{t('tv_join_code', { code: data.table.joinCode ?? '' })}</p>
          </>
        ) : <p className="muted">{t('tv_join_unavailable')}</p>}
      </section>
      <section className="tv-panel">
        <h2 className="tv-panel-title">{t('tv_recent')}</h2>
        {data.recent.length === 0 ? <p className="muted tv-empty">{t('tv_recent_empty')}</p> : (
          <ol className="tv-recent">
            {data.recent.map((r) => (
              <li key={r.handNumber}><span className="faint num">#{r.handNumber}</span><Flop cards={r.cards} size="sm" /></li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

interface Props {
  readonly data: CashTvData;
  readonly connection: TvConnection;
  readonly reveal: string[] | null;
  readonly offsetMs: number;
}

/** Ring Game TV: header, the stage for the hand state, and the join QR with the last flops. No names or balances. */
export function CashTvView({ data, connection, reveal, offsetMs }: Props) {
  const header = [data.table.clubName, data.table.roomName, data.table.name].filter(Boolean).join(' · ');
  return (
    <>
      <header className="tv-head">
        <h1 className="tv-title truncate">{header}</h1>
        <LiveBadge connection={connection} />
      </header>
      <main className="tv-grid">
        <Stage data={data} reveal={reveal} offsetMs={offsetMs} />
        <Side data={data} />
      </main>
    </>
  );
}
