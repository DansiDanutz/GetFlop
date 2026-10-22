import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Segmented, Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, points, signed } from '../../../lib/format';
import { useSession } from '../../../state/session';
import { INSP, LIVE_REFRESH_MS } from '../api';
import { browserTz, centsToCsv, downloadText, toCsv } from '../model/reports';
import { Strip, tone, useMarketName, useReportsIndex } from './parts';
import type { LiveBets, LivePoints, LiveWindow } from './types';

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function WindowLabel({ w }: { w: LiveWindow }) {
  const t = useT();
  return <span className="eyebrow">{w.kind === 'session' ? t('insp_window_session', { n: w.number ?? '', since: time(w.since) }) : t('insp_window_today', { since: time(w.since) })}</span>;
}

/** "↑ n new" when rows arrived while the list is scrolled down. */
function useNewPill(ids: readonly string[]): { count: number; reset: () => void } {
  const seen = useRef<string | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (ids.length === 0) return;
    if (seen.current === null || window.scrollY < 200) { seen.current = ids[0]!; setCount(0); return; }
    const i = ids.indexOf(seen.current);
    setCount(i < 0 ? ids.length : i);
  }, [ids]);
  return { count, reset: () => { seen.current = ids[0] ?? null; setCount(0); window.scrollTo({ top: 0, behavior: 'smooth' }); } };
}

function CouponsFeed() {
  const t = useT();
  const navigate = useNavigate();
  const index = useReportsIndex();
  const marketName = useMarketName();
  const [tableId, setTableId] = useState('');
  const [wins, setWins] = useState(false);
  const [big, setBig] = useState(false);
  const q = useQuery({
    queryKey: [INSP, 'live-bets', tableId, wins, big],
    queryFn: () => api.get<LiveBets>(`/inspector/live/bets${qs({ tz: browserTz(), tableId, wins: wins ? 1 : undefined, big: big ? 1 : undefined })}`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const rows = q.data?.rows ?? [];
  const pill = useNewPill(rows.map((r) => r.couponId));
  const outcome = (r: LiveBets['rows'][number]) => {
    if (r.outcome === 'in_progress') return t('insp_in_progress');
    if (r.outcome === 'won') return t('insp_won_x', { amount: amount(r.wonCents) });
    if (r.outcome === 'lost') return t('insp_lost_x', { amount: amount(r.lostCents) });
    return t('insp_voided');
  };
  const exportCsv = () => downloadText('live-coupons.csv', toCsv(
    ['Time', 'Player', 'Table', 'Picks', 'Flops', 'Status', 'Committed PTS', 'Won PTS'],
    rows.map((r) => [r.createdAt, r.player, r.tableName, r.picks.map((p) => `${p.market} ${points(p.stakeCents)}`).join(' + '),
      `${r.roundsSettled}/${r.rounds}`, r.outcome, centsToCsv(r.committedCents), centsToCsv(r.wonCents)]),
  ));

  return (
    <div className="stack">
      {q.data && <WindowLabel w={q.data.window} />}
      {q.data && (
        <Strip items={[
          { label: t('insp_played'), value: amount(q.data.totals.stakedCents) },
          { label: t('insp_won_by_players'), value: amount(q.data.totals.paidCents) },
          { label: t('insp_club'), value: signed(q.data.totals.clubCents), tone: tone(q.data.totals.clubCents) },
        ]} />
      )}
      <div className="chips">
        <select value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label={t('insp_all_tables')}>
          <option value="">{t('insp_all_tables')}</option>
          {(index.data?.tables ?? []).filter((x) => x.status !== 'archived').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button type="button" className={`chip${wins ? ' on' : ''}`} onClick={() => setWins(!wins)}>{t('insp_only_wins')}</button>
        <button type="button" className={`chip${big ? ' on' : ''}`} onClick={() => setBig(!big)}>{t('insp_big_filter', { n: points(q.data?.bigThresholdCents ?? index.data?.bigThresholdCents ?? 0) })}</button>
        <button type="button" className="chip" disabled={rows.length === 0} onClick={exportCsv}>{t('insp_csv')}</button>
      </div>
      {pill.count > 0 && <button type="button" className="btn primary insp-pill" onClick={pill.reset}>{t('insp_new_rows', { n: pill.count })}</button>}
      {q.isLoading && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {q.data && rows.length === 0 && <Empty title={t('insp_live_empty')} />}
      <div className="card tight list">
        {rows.map((r) => (
          <div key={r.couponId} className={`list-row insp-live-row${r.isBig ? ' big' : ''}`}>
            <div className="grow insp-rowtext">
              <button type="button" className="btn link insp-player" onClick={() => navigate(`/club/card/${r.userId}`, { state: { back: '/club/reports/live' } })}>{r.player}</button>
              <span className="muted insp-sub">{r.tableName} · {r.picks.map((p) => `${marketName(p.market)} ${points(p.stakeCents)}`).join(' + ')}</span>
              <span className="faint insp-sub">{t('insp_flop_k_n', { k: r.roundsSettled, n: r.rounds })} · {time(r.createdAt)}</span>
            </div>
            <span className={r.outcome === 'won' ? 'win' : r.outcome === 'lost' ? 'loss' : 'muted'}>{outcome(r)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PointsFeed() {
  const t = useT();
  const { can } = useSession();
  const [actor, setActor] = useState<string>(can('settings') ? '' : 'me');
  const q = useQuery({
    queryKey: [INSP, 'live-points', actor],
    queryFn: () => api.get<LivePoints>(`/inspector/live/points${qs({ tz: browserTz(), actor })}`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const rows = q.data?.rows ?? [];
  const by = (r: LivePoints['rows'][number]) => {
    if (r.type === 'request' || r.type === 'return') return t('insp_approved_by', { name: r.byMe ? t('insp_you') : r.actor ?? '' });
    if (r.byPlayer) return t('insp_by_player');
    return r.byMe ? t('insp_by_you') : t('insp_by_name', { name: r.actor ?? '' });
  };
  const exportCsv = () => downloadText('live-points.csv', toCsv(
    ['Time', 'Type', 'Player', 'Amount PTS', 'By'], rows.map((r) => [r.createdAt, r.type, r.player, centsToCsv(r.amountCents), r.actor ?? '']),
  ));
  return (
    <div className="stack">
      {q.data && <WindowLabel w={q.data.window} />}
      {q.data && (
        <Strip items={[
          { label: t('insp_given'), value: amount(q.data.totals.givenCents) },
          { label: t('insp_taken_back'), value: amount(q.data.totals.takenCents) },
          { label: t('insp_net'), value: signed(q.data.totals.netCents) },
        ]} />
      )}
      <div className="chips">
        <select value={actor} onChange={(e) => setActor(e.target.value)} aria-label={t('insp_all_staff')}>
          <option value="">{t('insp_all_staff')}</option>
          <option value="me">{t('insp_mine_only')}</option>
          {(q.data?.staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button type="button" className="chip" disabled={rows.length === 0} onClick={exportCsv}>{t('insp_csv')}</button>
      </div>
      {q.isLoading && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {q.data && rows.length === 0 && <Empty title={t('insp_points_empty')} />}
      <div className="card tight list">
        {rows.map((r) => (
          <div key={r.id} className="list-row">
            <div className="grow insp-rowtext">
              <strong>{t(`insp_move_${r.type}`)} · {r.player}</strong>
              <span className="faint insp-sub">{by(r)} · {time(r.createdAt)}</span>
            </div>
            <strong className={r.type === 'send_out' || r.type === 'request' ? 'win' : 'loss'}>{amount(r.amountCents)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LiveView() {
  const t = useT();
  const [view, setView] = useState<'coupons' | 'points'>('coupons');
  return (
    <div className="stack">
      <Segmented value={view} onChange={setView} options={[{ value: 'coupons', label: t('insp_live_coupons_tab') }, { value: 'points', label: t('insp_live_points_tab') }]} />
      {view === 'coupons' ? <CouponsFeed /> : <PointsFeed />}
      <p className="faint">{t('insp_tc_note')}</p>
    </div>
  );
}
