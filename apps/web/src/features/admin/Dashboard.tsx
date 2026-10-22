import { Link } from 'react-router-dom';
import { StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { AdminShell } from './AdminShell';
import { useAdmin, type Dashboard as DashboardData } from './api';
import { AuditActionLabel } from './Audit';
import { browserTz } from './logic';
import { Loadable, Pts, Section } from './parts';
import { PlatformFigures } from './PlatformFigures';

export function DashboardScreen() {
  const t = useT();
  const query = useAdmin<DashboardData>(['dashboard'], `/admin${qs({ tz: browserTz() })}`);
  return (
    <AdminShell>
      <h1>{t('admin_dashboard_title')}</h1>
      <Loadable query={query}>
        {(d) => (
          <div className="stack-lg">
            {d.driftingClubs.length > 0
              ? <div className="banner danger">{t('admin_drift_alert', { n: d.driftingClubs.length, names: d.driftingClubs.map((c) => c.name).join(', ') })}</div>
              : <div className="banner ok">{t('admin_drift_ok')}</div>}
            <div className="kpis">
              <StatTile label={t('admin_kpi_accounts')} value={d.accounts.all} />
              <StatTile label={t('admin_kpi_admins')} value={d.accounts.admins} />
              <StatTile label={t('admin_kpi_inactive')} value={d.accounts.inactive} />
              <StatTile label={t('admin_kpi_clubs')} value={d.clubs} />
              <StatTile label={t('admin_kpi_hands_today')} value={d.today.hands} />
              <StatTile label={t('admin_kpi_players_today')} value={d.today.players} />
              <StatTile label={t('admin_kpi_coupons_today')} value={d.today.coupons} />
              <StatTile label={t('admin_kpi_live_coupons')} value={d.live.liveCoupons} />
              <StatTile label={t('admin_kpi_tables_open')} value={d.live.tablesOpen} />
              <StatTile label={t('admin_kpi_online')} value={d.live.online} />
            </div>
            <Section title={t('admin_today_by_club')}>
              {d.todayClubs.length === 0 && <p className="muted">{t('admin_no_play_today')}</p>}
              {d.todayClubs.map((c) => (
                <div key={c.clubId} className="card tight row-card">
                  <strong>{c.name}</strong>
                  <span className="meta">
                    {t('admin_club_line', { hands: c.hands, players: c.players })} · {t('admin_played')} <Pts cents={c.playedCents} /> · {t('admin_club_result')} <Pts cents={c.resultCents} sign />
                  </span>
                </div>
              ))}
            </Section>
            <Section title={t('admin_recent_audit')} action={<Link to="/admin/audit" className="btn ghost">{t('admin_see_all')}</Link>}>
              {d.recentAudit.length === 0 && <p className="muted">{t('admin_audit_empty')}</p>}
              {d.recentAudit.map((a) => (
                <div key={a.id} className="list-row">
                  <span className="grow"><AuditActionLabel action={a.action} /> · <span className="muted">{a.actorName ?? '—'}</span></span>
                  <span className="faint">{dateTime(a.createdAt)}</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </Loadable>
      <PlatformFigures />
    </AdminShell>
  );
}
