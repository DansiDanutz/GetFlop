import { StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { AdminShell } from './AdminShell';
import { useAdmin, type Live } from './api';
import { handStatusKey } from './logic';
import { Loadable, Pts } from './parts';

export function LiveScreen() {
  const t = useT();
  const query = useAdmin<Live>(['live'], '/admin/live');
  return (
    <AdminShell>
      <h1>{t('admin_live_title')}</h1>
      <Loadable query={query}>
        {(d) => (
          <div className="stack-lg">
            <div className="kpis">
              <StatTile label={t('admin_kpi_tables_open')} value={d.totals.tablesOpen} />
              <StatTile label={t('admin_live_hands')} value={d.totals.liveHands} />
              <StatTile label={t('admin_live_pending_picks')} value={d.totals.pendingPicks} />
              <StatTile label={t('admin_kpi_live_coupons')} value={d.totals.liveCoupons} />
            </div>
            {d.tables.length === 0 && <p className="muted">{t('admin_live_empty')}</p>}
            {d.tables.map((x) => (
              <div key={x.tableId} className="card tight row-card">
                <div className="row-between">
                  <strong>{x.name}</strong>
                  {x.hand
                    ? <span className={`badge ${x.hand.status === 'betting_open' ? 'open' : 'closed'}`}>#{x.hand.handNumber} · {t(handStatusKey(x.hand.status))}</span>
                    : <span className="badge plain">{t('admin_live_no_hand')}</span>}
                </div>
                <span className="meta">
                  {x.clubName} · {x.kind === 'tournament' ? t('admin_kind_tournament') : t('admin_kind_cash')}
                  {' · '}{x.isAutoDeal ? t('admin_auto_dealt') : (x.dealerName ?? t('admin_no_dealer'))}
                </span>
                <span className="meta">
                  {t('admin_live_coupons_n', { n: x.liveCoupons })}
                  {x.hand && <> · {t('admin_live_picks_n', { n: x.hand.picks })} · <Pts cents={x.hand.stakeCents} unit={x.unit} /></>}
                </span>
              </div>
            ))}
          </div>
        )}
      </Loadable>
    </AdminShell>
  );
}
