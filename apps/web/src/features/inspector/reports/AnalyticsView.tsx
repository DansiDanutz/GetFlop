import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, dateTime, signed } from '../../../lib/format';
import { INSP, useDealers } from '../api';
import { pct } from '../model/reports';
import { Kv, LineTable, MarketBands, Strip, tone } from './parts';
import type { Analytics, SessionView } from './types';

const DAY = 86_400_000;
type Scope = { kind: 'current' } | { kind: 'session'; id: string } | { kind: 'last24h' } | { kind: '7d' } | { kind: 'all' };

function scopeParams(scope: Scope): Record<string, string | undefined> {
  const now = Date.now();
  if (scope.kind === 'session') return { sessionId: scope.id };
  if (scope.kind === 'last24h') return { from: new Date(now - DAY).toISOString() };
  if (scope.kind === '7d') return { from: new Date(now - 7 * DAY).toISOString() };
  if (scope.kind === 'all') return { from: new Date(0).toISOString() };
  return {};
}

/** Sessions: open / close with the summary sheet; closing starts the next one at once. */
function SessionBar({ onScope }: { onScope: (s: Scope) => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [INSP, 'session'], queryFn: () => api.get<{ open: SessionView | null; recent: SessionView[] }>('/inspector/session') });
  const [closed, setClosed] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: 'open' | 'close') {
    setBusy(true);
    try {
      const res = await api.post<{ closed: SessionView } | SessionView>(`/inspector/session/${path}`);
      if (path === 'close' && 'closed' in res) setClosed(res.closed);
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const open = q.data?.open;
  return (
    <div className="card stack">
      {q.isLoading && <Spinner />}
      {open ? (
        <div className="row-between">
          <span>{t('insp_session_open', { n: open.number, since: dateTime(open.openedAt) })}</span>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void act('close')}>{t('insp_session_close')}</button>
        </div>
      ) : q.data && (
        <div className="row-between">
          <span className="muted">{t('insp_session_none')}</span>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act('open')}>{t('insp_session_start')}</button>
        </div>
      )}
      <select aria-label={t('insp_scope')} onChange={(e) => {
        const v = e.target.value;
        onScope(v.startsWith('s:') ? { kind: 'session', id: v.slice(2) } : ({ kind: v } as Scope));
      }}>
        <option value="current">{t('insp_scope_current')}</option>
        {(q.data?.recent ?? []).map((s) => <option key={s.id} value={`s:${s.id}`}>{t('insp_scope_session', { n: s.number, date: dateTime(s.openedAt) })}</option>)}
        <option value="last24h">{t('insp_scope_24h')}</option>
        <option value="7d">{t('insp_scope_7d')}</option>
        <option value="all">{t('insp_scope_all')}</option>
      </select>
      <Sheet open={Boolean(closed)} onClose={() => setClosed(null)} title={closed ? t('insp_session_closed', { n: closed.number }) : ''}>
        {closed?.summary && (
          <Kv rows={[
            [t('insp_col_hands'), closed.summary.hands],
            [t('insp_players'), closed.summary.players],
            [t('insp_handle'), amount(closed.summary.handleCents)],
            [t('insp_club_result'), signed(closed.summary.resultCents)],
          ]} />
        )}
        <p className="muted">{t('insp_session_next_started')}</p>
      </Sheet>
    </div>
  );
}

/** Reports → Analytics (07 §4.4). */
export function AnalyticsView() {
  const t = useT();
  const dealers = useDealers();
  const [scope, setScope] = useState<Scope>({ kind: 'current' });
  const [source, setSource] = useState('');
  const [includeBots, setIncludeBots] = useState(false);
  const dealerId = source.startsWith('d:') ? source.slice(2) : undefined;
  const params = { ...scopeParams(scope), source: source === 'auto' ? 'auto' : dealerId ? 'dealer' : undefined, dealerId, includeBots: includeBots ? 1 : undefined };
  const q = useQuery({ queryKey: [INSP, 'analytics', params], queryFn: () => api.get<Analytics>(`/inspector/analytics${qs(params)}`) });
  const a = q.data;

  return (
    <div className="stack">
      <SessionBar onScope={setScope} />
      <div className="grid-2">
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t('insp_dealt_by_filter')}>
          <option value="">{t('insp_dealt_anyone')}</option>
          <option value="auto">{t('insp_auto_deal')}</option>
          {(dealers.data ?? []).map((d) => <option key={d.id} value={`d:${d.id}`}>{d.displayName}</option>)}
        </select>
        <label className="checkbox"><input type="checkbox" checked={includeBots} onChange={(e) => setIncludeBots(e.target.checked)} />{t('insp_include_sim')}</label>
      </div>
      {q.isLoading && <Spinner />}
      {q.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {a && (
        <>
          <Strip items={[
            { label: t('insp_handle'), value: amount(a.handleCents) },
            { label: t('insp_ggr'), value: signed(a.ggrCents), tone: tone(a.ggrCents) },
            { label: t('insp_hold'), value: `${pct(a.holdPct)} / ${pct(a.theoHoldPct)}` },
          ]} />
          <p className="muted">{t('insp_hands_n', { n: a.hands })} · {t('insp_picks_players', { b: a.picks, p: a.players })}</p>
          <span className="section-title">{t('insp_by_market')}</span>
          <MarketBands stats={a.byMarket} />
          <span className="section-title">{t('insp_by_dealer')}</span>
          <LineTable rows={a.byDealer.map((d) => ({ ...d, key: d.auto ? 'auto' : d.dealerId ?? '-' }))}
            nameOf={(key) => (key === 'auto' ? <span className="pill">{t('insp_auto_tag')}</span> : a.byDealer.find((d) => d.dealerId === key)?.name ?? '—')} />
          {a.notRecorded > 0 && <p className="faint">{t('insp_not_recorded', { n: a.notRecorded })}</p>}
          <span className="section-title">{t('insp_by_table')}</span>
          <LineTable rows={a.byTable.map((x) => ({ ...x, key: x.tableId }))} nameOf={(key) => a.byTable.find((x) => x.tableId === key)?.name ?? ''} />
          <span className="section-title">{t('insp_balance_check')}</span>
          {!a.drift.ok && <div className="banner">{t('insp_alert_drift_unknown')}</div>}
          {a.drift.ok && a.drift.driftingCount === 0 && <div className="banner ok">{t('insp_drift_ok', { n: a.drift.checked })}</div>}
          {a.drift.ok && a.drift.driftingCount > 0 && (
            <div className="banner danger">{t('insp_drift_bad', { n: a.drift.driftingCount, total: a.drift.checked, largest: amount(a.drift.worstDriftCents) })}</div>
          )}
        </>
      )}
    </div>
  );
}
