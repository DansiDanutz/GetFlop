import { useState } from 'react';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { qs } from '../../lib/api';
import { AdminShell } from './AdminShell';
import { useAdmin, type PlayerNet, type ReconDay, type Reconciliation } from './api';
import { browserTz, downloadCsv, toCsv } from './logic';
import { Loadable, Pts, Section } from './parts';

type View = 'reconciliation' | 'players';

export function ReconciliationView() {
  const t = useT();
  const query = useAdmin<Reconciliation>(['reconciliation'], `/admin/financials/reconciliation${qs({ tz: browserTz() })}`);
  const csv = (days: ReconDay[]) => downloadCsv('reconciliation.csv', toCsv(
    ['date', 'club', 'picks', 'played', 'won_by_players', 'club_result', 'sent', 'claimed_back'],
    days.map((d) => [d.date, d.clubName, d.picks, d.playedCents / 100, d.wonCents / 100, d.resultCents / 100, d.sentCents / 100, d.claimedCents / 100]),
  ));
  return (
    <Loadable query={query}>
      {(d) => (
        <div className="stack-lg">
          <Section title={t('admin_supply_checks')}>
            {d.clubs.map((c) => (
              <div key={c.clubId} className={`card tight row-card ${c.drift !== 0 ? 'edge-neg' : ''}`}>
                <div className="row-between">
                  <strong>{c.clubName}</strong>
                  <span className={`badge plain ${c.drift === 0 ? 'live' : 'closed'}`}>{c.drift === 0 ? t('admin_supply_ok') : t('admin_supply_drift')}</span>
                </div>
                <span className="meta">
                  {t('admin_issued')} <Pts cents={c.issuedCents} /> · {t('admin_pool')} <Pts cents={c.poolCents} /> · {t('admin_wallets')} <Pts cents={c.walletsCents} />
                  {' · '}{t('admin_riding')} <Pts cents={c.ridingCents} />{c.drift !== 0 && <> · {t('admin_drift')} <Pts cents={c.drift} sign /></>}
                </span>
                {c.driftingWallets > 0 && <span className="meta neg">{t('admin_wallets_drifting', { n: c.driftingWallets })}</span>}
              </div>
            ))}
          </Section>
          <Section title={t('admin_club_days')} action={d.days.length > 0 && <button type="button" className="btn ghost" onClick={() => csv(d.days)}>{t('admin_csv')}</button>}>
            <p className="muted">{t('admin_club_days_note')}</p>
            {d.days.length === 0 && <p className="muted">{t('admin_nothing_here')}</p>}
            <div className="table-wrap">
              <table className="data">
                <thead><tr>
                  <th>{t('admin_date')}</th><th>{t('admin_club')}</th><th className="num">{t('admin_picks')}</th><th className="num">{t('admin_played')}</th>
                  <th className="num">{t('admin_won_by_players')}</th><th className="num">{t('admin_club_result')}</th>
                  <th className="num">{t('admin_sent')}</th><th className="num">{t('admin_claimed')}</th>
                </tr></thead>
                <tbody>
                  {d.days.map((r) => (
                    <tr key={`${r.date}-${r.clubId}`}>
                      <td>{r.date}</td><td>{r.clubName}</td><td className="num">{r.picks}</td>
                      <td className="num"><Pts cents={r.playedCents} /></td><td className="num"><Pts cents={r.wonCents} /></td>
                      <td className="num"><Pts cents={r.resultCents} sign /></td>
                      <td className="num"><Pts cents={r.sentCents} /></td><td className="num"><Pts cents={r.claimedCents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      )}
    </Loadable>
  );
}

function PlayersTodayView() {
  const t = useT();
  const query = useAdmin<{ players: PlayerNet[] }>(['daily-player-net'], `/admin/financials/daily-player-net${qs({ tz: browserTz() })}`);
  const csv = (players: PlayerNet[]) => downloadCsv('players-today.csv', toCsv(
    ['player', 'club', 'in', 'out', 'balance', 'played', 'won', 'net'],
    players.map((p) => [p.name, p.clubName, p.inCents / 100, p.outCents / 100, p.balanceCents / 100, p.playedCents / 100, p.wonCents / 100, p.netCents / 100]),
  ));
  return (
    <Loadable query={query}>
      {(d) => (
        <Section title={t('admin_all_players', { n: d.players.length })} action={d.players.length > 0 && <button type="button" className="btn ghost" onClick={() => csv(d.players)}>{t('admin_csv')}</button>}>
          {d.players.length === 0 && <p className="muted">{t('admin_no_player_today')}</p>}
          {d.players.map((p) => (
            <div key={`${p.clubId}-${p.userId}`} className="card tight row-card">
              <div className="row-between"><strong>{p.name}</strong><span className="faint">{p.clubName}</span></div>
              <span className="meta">
                {t('admin_in')} <Pts cents={p.inCents} /> · {t('admin_out')} <Pts cents={p.outCents} /> · {t('admin_balance')} <Pts cents={p.balanceCents} />
              </span>
              <span className="meta">{t('admin_played')} <Pts cents={p.playedCents} /> · {t('admin_won')} <Pts cents={p.wonCents} /> · {t('admin_net')} <Pts cents={p.netCents} sign /></span>
            </div>
          ))}
        </Section>
      )}
    </Loadable>
  );
}

export function FinanceView({ initial = 'reconciliation' }: { initial?: View }) {
  const t = useT();
  const [view, setView] = useState<View>(initial);
  return (
    <div className="stack">
      <h1>{t('admin_finance_title')}</h1>
      <Segmented value={view} onChange={setView}
        options={[{ value: 'reconciliation', label: t('admin_reconciliation') }, { value: 'players', label: t('admin_players_today') }]} />
      {view === 'reconciliation' ? <ReconciliationView /> : <PlayersTodayView />}
    </div>
  );
}

export function FinanceScreen() {
  return <AdminShell><FinanceView /></AdminShell>;
}
