import { useState } from 'react';
import { StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { qs } from '../../lib/api';
import { useAdmin, type ClubFigures, type MarketReport, type Platform } from './api';
import { browserTz, pct, periodRange, verdictKey, type PeriodPreset } from './logic';
import { labelOr, Loadable, PeriodChips, Pts, Section } from './parts';

const MARKETS_SHORT = 6;
const DEVICES_SHORT = 8;

/** "Platform" block: health, KPIs, online now, devices, clubs and markets for a period. */
export function PlatformFigures() {
  const t = useT();
  const [period, setPeriod] = useState<PeriodPreset>('today');
  const params = periodRange(period, new Date(), browserTz());
  const query = useAdmin<Platform>(['platform', params], `/admin/platform${qs({ ...params })}`);
  return (
    <Section title={t('admin_platform_title')}>
      <PeriodChips value={period} onChange={setPeriod} />
      <Loadable query={query}>
        {(p) => (
          <div className="stack-lg">
            <p className="muted">{t('admin_health', { ms: p.health.dbMs, n: p.health.connections })}</p>
            <div className="kpis">
              <StatTile label={t('admin_kpi_hands_dealt', { n: p.kpis.clubsWithHands })} value={p.kpis.handsDealt} />
              <StatTile label={t('admin_kpi_players_played')} value={p.kpis.playersWhoPlayed} />
              <StatTile label={t('admin_kpi_coupons_bought')} value={p.kpis.couponsBought} />
              <StatTile label={t('admin_kpi_live_coupons')} value={p.kpis.liveCoupons} />
              <StatTile label={t('admin_kpi_clubs')} value={p.kpis.clubs} />
              <StatTile label={t('admin_kpi_tables_open')} value={p.kpis.tablesOpen} />
            </div>
            <OnlineNow online={p.online} />
            <Devices devices={p.devices} />
            <ClubsBlock clubs={p.clubs} idle={p.idleClubs} />
            <MarketsBlock markets={p.markets} />
          </div>
        )}
      </Loadable>
    </Section>
  );
}

function OnlineNow({ online }: { online: Platform['online'] }) {
  const t = useT();
  return (
    <Section title={t('admin_online_title')}>
      <p>{t('admin_online_line', { n: online.connected, tables: online.atTables, lobby: online.lobby })}</p>
      {online.tables.map((x) => (
        <div key={x.tableId} className="list-row">
          <span className="grow">{x.name ?? x.tableId}{x.kind === 'tournament' ? ` · ${t('admin_kind_tournament')}` : ''}</span>
          <span className="pill">{x.users}</span>
        </div>
      ))}
    </Section>
  );
}

function Devices({ devices }: { devices: Platform['devices'] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const list = all ? devices.list : devices.list.slice(0, DEVICES_SHORT);
  return (
    <Section title={t('admin_devices_title')}>
      <p className="muted">{t('admin_devices_line', { app: devices.withApp ?? '—', n: devices.loginsToday })}</p>
      {list.map((d) => (
        <div key={d.userId} className="list-row">
          <span className="grow">{d.name}</span>
          <span className="pill">{labelOr(`admin_device_${d.device}`, d.device)}</span>
          <span className="faint">{d.app === null ? t('admin_app_unknown') : d.app ? t('admin_app_installed') : t('admin_app_browser')}</span>
        </div>
      ))}
      {devices.list.length > DEVICES_SHORT && (
        <button type="button" className="btn ghost" onClick={() => setAll(!all)}>
          {all ? t('admin_show_fewer') : t('admin_show_all', { n: devices.list.length })}
        </button>
      )}
    </Section>
  );
}

function ClubsBlock({ clubs, idle }: { clubs: ClubFigures[]; idle: number }) {
  const t = useT();
  const played = clubs.filter((c) => c.hands > 0 || c.picks > 0 || c.ridingCents > 0);
  return (
    <Section title={t('admin_clubs_title')}>
      <p className="muted">{t('admin_clubs_note')}</p>
      {played.map((c) => (
        <div key={c.clubId} className="card tight row-card">
          <div className="row-between"><strong>{c.name}</strong><span className="faint">{c.publicId}</span></div>
          <dl className="kv">
            <dt>{t('admin_hands')}</dt><dd>{c.hands}</dd>
            <dt>{t('admin_players')}</dt><dd>{c.players}</dd>
            <dt>{t('admin_played')}</dt><dd><Pts cents={c.playedCents} /></dd>
            <dt>{t('admin_won_by_players')}</dt><dd><Pts cents={c.wonCents} /></dd>
            <dt>{t('admin_club_result')}</dt><dd><Pts cents={c.resultCents} sign /></dd>
            <dt>{t('admin_riding')}</dt><dd><Pts cents={c.ridingCents} /></dd>
          </dl>
          <a href={`#/club/members/${c.clubId}`}>{t('admin_members_link')}</a>
        </div>
      ))}
      {idle > 0 && <p className="muted">{t('admin_idle_clubs', { n: idle })}</p>}
    </Section>
  );
}

function MarketsBlock({ markets }: { markets: MarketReport[] }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const list = all ? markets : markets.slice(0, MARKETS_SHORT);
  return (
    <Section title={t('admin_markets_report_title')}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr>
            <th>{t('admin_market')}</th><th className="num">{t('admin_picks')}</th><th className="num">{t('admin_hits')}</th>
            <th className="num">{t('admin_priced_for')}</th><th>{t('admin_verdict')}</th>
          </tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.slug}>
                <td>{m.name}{m.retired && <span className="pill"> {t('admin_retired')}</span>}</td>
                <td className="num">{m.picks}</td>
                <td className="num">{m.hits} ({pct(m.hitRate)})</td>
                <td className="num">{pct(m.probability)}</td>
                <td className={m.verdict === 'more' ? 'neg' : undefined}>{t(verdictKey(m.verdict))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {markets.length > MARKETS_SHORT && (
        <button type="button" className="btn ghost" onClick={() => setAll(!all)}>
          {all ? t('admin_show_fewer') : t('admin_all_markets', { n: markets.length })}
        </button>
      )}
    </Section>
  );
}
