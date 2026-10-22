import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Flop } from '../../../components/PlayingCard';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { Empty, Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, dateTime, signed } from '../../../lib/format';
import { useSession } from '../../../state/session';
import { INSP } from '../api';
import { browserTz, pct, periodQuery, type PeriodChip } from '../model/reports';
import { downloadServerCsv, Kv, LineTable, MarketBands, tone, useMarketName, useReportsIndex } from './parts';
import type { HandDetail, HandsResult, Summary } from './types';

const CHIPS: PeriodChip[] = ['today', '7d', '30d', 'all', 'custom'];

export function PeriodPicker({ chip, onChip, custom, onCustom }: {
  chip: PeriodChip; onChip: (c: PeriodChip) => void; custom: { from: string; to: string }; onCustom: (c: { from: string; to: string }) => void;
}) {
  const t = useT();
  return (
    <div className="stack">
      <div className="chips">
        {CHIPS.map((c) => <button key={c} type="button" className={`chip${c === chip ? ' on' : ''}`} onClick={() => onChip(c)}>{t(`insp_period_${c}`)}</button>)}
      </div>
      {chip === 'custom' && (
        <div className="grid-2">
          <input type="date" value={custom.from} aria-label={t('insp_from')} onChange={(e) => onCustom({ ...custom, from: e.target.value })} />
          <input type="date" value={custom.to} aria-label={t('insp_to')} onChange={(e) => onCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}

function TablePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  const index = useReportsIndex();
  const [search, setSearch] = useState('');
  const tables = (index.data?.tables ?? []).filter((x) => x.name.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="grid-2">
      <input value={search} placeholder={t('insp_search_table')} onChange={(e) => setSearch(e.target.value)} />
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('insp_all_tables')}>
        <option value="">{t('insp_all_tables')}</option>
        {tables.map((x) => <option key={x.id} value={x.id}>{x.name}{x.status !== 'open' ? ` · ${t(`insp_status_${x.status}`)}` : ''}</option>)}
      </select>
    </div>
  );
}

function HandDetailSheet({ handId, onClose }: { handId: string | null; onClose: () => void }) {
  const t = useT();
  const marketName = useMarketName();
  const q = useQuery({
    queryKey: [INSP, 'hand', handId],
    queryFn: () => api.get<HandDetail>(`/inspector/hands/${handId}`),
    enabled: Boolean(handId),
  });
  const d = q.data;
  const unit = d?.unit ?? 'points';
  return (
    <Sheet open={Boolean(handId)} onClose={onClose} title={d ? t('insp_hand_title', { n: d.hand.handNumber, table: d.table.name }) : t('insp_hand')}>
      {q.isLoading && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {d && (
        <div className="stack">
          <Flop cards={d.hand.flop} size="md" />
          <span className="muted">{d.dealtBy.kind === 'auto' ? t('insp_dealt_auto') : t('insp_dealt_by', { name: d.dealtBy.name ?? '' })}</span>
          {d.isTournament && <div className="banner">{t('insp_chips_note')}</div>}
          {d.players.length === 0 && <p className="muted">{t('insp_nobody_played')}</p>}
          {d.players.map((p) => (
            <div key={p.userId} className="card tight stack">
              <div className="row-between"><strong>{p.name}</strong><span className="muted">{t('insp_played_won', { s: amount(p.playedCents, unit), w: amount(p.wonCents, unit) })}</span></div>
              {p.picks.map((pk) => (
                <div key={pk.betId} className="row-between insp-sub">
                  <span>{marketName(pk.market)} · {amount(pk.stakeCents, unit)}</span>
                  <span className={pk.status === 'won' ? 'win' : pk.status === 'lost' ? 'loss' : 'muted'}>{t(`insp_pick_${pk.status}`)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}

function SummaryBlock({ s }: { s: Summary }) {
  const t = useT();
  const k = s.kpis;
  return (
    <details className="card stack">
      <summary className="section-title">{t('insp_summary_title')}</summary>
      <Kv rows={[
        [t('insp_col_hands'), k.hands],
        [t('insp_played'), amount(k.playedCents)],
        [t('insp_won_by_players'), amount(k.paidCents)],
        [t('insp_club_result'), <span key="r" className={tone(k.resultCents)}>{signed(k.resultCents)} · {pct(k.holdPct)}</span>],
        [t('insp_trn_entries'), k.tournaments.entries],
        [t('insp_trn_collected'), amount(k.tournaments.collectedCents)],
        [t('insp_trn_prizes'), amount(k.tournaments.prizesCents)],
      ]} />
      <span className="eyebrow">{t('insp_by_room')}</span>
      <LineTable rows={s.byRoom.map((r) => ({ ...r, key: r.roomId ?? '-' }))} nameOf={(key) => s.byRoom.find((r) => (r.roomId ?? '-') === key)?.name ?? t('insp_no_room')} />
      <span className="eyebrow">{t('insp_by_table')}</span>
      <LineTable rows={s.byTable.map((r) => ({ ...r, key: r.tableId }))} nameOf={(key) => s.byTable.find((r) => r.tableId === key)?.name ?? ''} />
      <span className="eyebrow">{t('insp_by_market')}</span>
      <MarketBands stats={s.byMarket} />
      <span className="eyebrow">{t('insp_by_player')}</span>
      <PlayerTable rows={s.byPlayer} />
      <p className="faint">{t('insp_summary_note')}</p>
    </details>
  );
}

export function PlayerTable({ rows }: { rows: Summary['byPlayer'] }) {
  const t = useT();
  if (rows.length === 0) return <p className="muted">{t('insp_no_picks')}</p>;
  return (
    <div className="scroll-x">
      <table className="data">
        <thead><tr><th>{t('insp_col_name')}</th><th className="num">{t('insp_col_won')}</th><th className="num">{t('insp_col_in')}</th><th className="num">{t('insp_col_out')}</th><th className="num">{t('insp_col_balance')}</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.userId}><td>{p.name}</td><td className="num">{amount(p.wonCents)}</td><td className="num">{amount(p.inCents)}</td><td className="num">{amount(p.outCents)}</td><td className="num">{amount(p.balanceCents)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Reports → Hands: filters, results summary, the hands list, detail and CSV (07 §4.2–4.3). */
export function HandsView() {
  const t = useT();
  const toast = useToast();
  const { context } = useSession();
  const [chip, setChip] = useState<PeriodChip>('today');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [tableId, setTableId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const tz = browserTz();
  const params = useMemo(() => ({ ...periodQuery(chip, new Date(), tz, custom), tableId, tz }), [chip, custom, tableId, tz]);
  const hands = useQuery({ queryKey: [INSP, 'hands', params], queryFn: () => api.get<HandsResult>(`/inspector/results${qs(params)}`) });
  const summary = useQuery({ queryKey: [INSP, 'summary', params], queryFn: () => api.get<Summary>(`/inspector/summary${qs(params)}`) });

  const csv = () => downloadServerCsv('/inspector/results', params, context?.club.id ?? '', 'hands.csv').catch((err) => toast.error(err));

  return (
    <div className="stack">
      <PeriodPicker chip={chip} onChip={setChip} custom={custom} onCustom={setCustom} />
      <TablePicker value={tableId} onChange={setTableId} />
      {summary.data && <SummaryBlock s={summary.data} />}
      <div className="row-between">
        <span className="section-title">{t('insp_hands_title')}</span>
        <button type="button" className="chip" disabled={!hands.data?.hands.length} onClick={() => void csv()}>{t('insp_csv')}</button>
      </div>
      {hands.isLoading && <Spinner />}
      {hands.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {hands.data && hands.data.hands.length === 0 && <Empty title={t('insp_no_hands')} />}
      {hands.data?.truncated && <p className="faint">{t('insp_hands_truncated', { n: hands.data.limit })}</p>}
      <div className="card tight list">
        {(hands.data?.hands ?? []).map((h) => (
          <button key={h.id} type="button" className="list-row insp-rowbtn" onClick={() => setOpen(h.id)}>
            <Flop cards={h.flop} size="sm" />
            <span className="grow insp-rowtext">
              <strong>#{h.handNumber} · {h.tableName}{h.kind === 'tournament' ? <span className="pill"> {t('insp_tournament_tag')}</span> : null}</strong>
              <span className="muted insp-sub">{t('insp_picks_wt', { w: h.winningBets, t: h.bets })} · {t('insp_played')} {amount(h.playedCents, h.unit)} · {t('insp_won_by_players')} {amount(h.paidCents, h.unit)}</span>
              <span className="faint insp-sub">{dateTime(h.settledAt)}</span>
            </span>
            <strong className={tone(h.holdCents)}>{signed(h.holdCents, h.unit)}</strong>
          </button>
        ))}
      </div>
      <HandDetailSheet handId={open} onClose={() => setOpen(null)} />
    </div>
  );
}
