import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '../../../components/Toast';
import { Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, signed } from '../../../lib/format';
import { useSession } from '../../../state/session';
import { INSP } from '../api';
import { isoToLocalInput, localInputToIso, pct } from '../model/reports';
import { PlayerTable } from './HandsView';
import { downloadServerCsv, Kv, LineTable, MarketBands, tone, useReportsIndex } from './parts';
import type { ShiftReport } from './types';

function defaultFrom(): string {
  const d = new Date();
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setHours(6, 0, 0, 0);
  return isoToLocalInput(d);
}

/** Reports → Report: the shift report for a time range and tables (07 §4.5). */
export function ShiftReportView() {
  const t = useT();
  const toast = useToast();
  const { context } = useSession();
  const index = useReportsIndex();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(() => isoToLocalInput(new Date()));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [params, setParams] = useState<Record<string, string> | null>(null);
  const q = useQuery({
    queryKey: [INSP, 'shift-report', params],
    queryFn: () => api.get<ShiftReport>(`/inspector/report${qs(params ?? {})}`),
    enabled: Boolean(params),
  });

  function generate() {
    const fromIso = localInputToIso(from);
    const toIso = localInputToIso(to);
    if (!fromIso || !toIso) return toast.show(t('err_report_range_invalid'), 'error');
    setParams({ fromDatetime: fromIso, toDatetime: toIso, ...(picked.size ? { tableIds: [...picked].join(',') } : {}) });
  }
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const r = q.data;

  return (
    <div className="stack">
      <div className="card stack">
        <div className="grid-2">
          <label className="stack"><span className="eyebrow">{t('insp_from')}</span><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="stack"><span className="eyebrow">{t('insp_to')}</span><input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <span className="eyebrow">{t('insp_report_tables')}</span>
        <div className="chips">
          {(index.data?.tables ?? []).map((x) => (
            <button key={x.id} type="button" className={`chip${picked.has(x.id) ? ' on' : ''}`} onClick={() => toggle(x.id)}>{x.name}</button>
          ))}
        </div>
        <button type="button" className="btn primary block" onClick={generate}>{t('insp_generate_report')}</button>
      </div>
      {q.isFetching && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {r && params && (
        <>
          <div className="row-between">
            <span className="section-title">{t('insp_report_title')}</span>
            <button type="button" className="chip" onClick={() => void downloadServerCsv('/inspector/report', params, context?.club.id ?? '', 'shift-report.csv').catch((e) => toast.error(e))}>{t('insp_csv')}</button>
          </div>
          <section className="card stack">
            <Kv rows={[
              [t('insp_points_in'), amount(r.points.inCents)],
              [t('insp_points_out'), amount(r.points.outCents)],
              [t('insp_net'), signed(r.points.netCents)],
              [t('insp_played'), amount(r.play.playedCents)],
              [t('insp_won_by_players'), amount(r.play.paidCents)],
              [t('insp_house_hold'), <span key="h" className={tone(r.play.holdCents)}>{signed(r.play.holdCents)} · {pct(r.play.holdPct)}</span>],
            ]} />
          </section>
          <section className="card stack">
            <span className="eyebrow">{t('insp_tournaments')}</span>
            <Kv rows={[
              [t('insp_trn_entries'), r.tournaments.entries],
              [t('insp_trn_buyins'), amount(r.tournaments.buyinsCents)],
              [t('insp_trn_rebuys'), amount(r.tournaments.rebuysCents)],
              [t('insp_trn_addons'), amount(r.tournaments.addonsCents)],
              [t('insp_trn_prizes'), amount(r.tournaments.prizesCents)],
              [t('insp_trn_result'), signed(r.tournaments.resultCents)],
            ]} />
          </section>
          <span className="section-title">{t('insp_by_market_ring')}</span>
          <MarketBands stats={r.byMarket.ring} />
          {r.byMarket.chips.length > 0 && (<><span className="section-title">{t('insp_by_market_chips')}</span><MarketBands stats={r.byMarket.chips} /></>)}
          <span className="section-title">{t('insp_by_room')}</span>
          <LineTable rows={r.byRoom.map((x) => ({ ...x, key: x.roomId ?? '-' }))} nameOf={(key) => r.byRoom.find((x) => (x.roomId ?? '-') === key)?.name ?? t('insp_no_room')} />
          <span className="section-title">{t('insp_by_table')}</span>
          <LineTable rows={r.byTable.map((x) => ({ ...x, key: x.tableId }))} nameOf={(key) => r.byTable.find((x) => x.tableId === key)?.name ?? ''} />
          <span className="section-title">{t('insp_by_player')}</span>
          <PlayerTable rows={r.byPlayer} />
        </>
      )}
    </div>
  );
}
