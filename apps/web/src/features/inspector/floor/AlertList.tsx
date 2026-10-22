import { useNavigate } from 'react-router-dom';
import { useT } from '../../../i18n/i18n';
import { amount } from '../../../lib/format';
import { useSession } from '../../../state/session';
import { alertView, duration, type FloorAlert } from '../model/floor';

interface Props {
  alerts: readonly FloorAlert[];
  dealing: number;
  onTable: (tableId: string, action: 'assign' | 'menu') => void;
}

function alertParams(alert: FloorAlert, t: ReturnType<typeof useT>): Record<string, string | number> {
  const p = alert.params;
  if (alert.code === 'idle') {
    const d = duration(Number(p.minutes ?? 0) * 60_000);
    return { ...p, duration: t(d.key, d.params) };
  }
  if (alert.code === 'drift') return { ...p, largest: amount(Number(p.largest ?? 0)) };
  if (alert.code === 'tournament_soon') {
    const d = duration(Number(p.minutes ?? 0) * 60_000);
    return { ...p, duration: t(d.key, d.params) };
  }
  return p;
}

/** "NEEDS YOU · n" rows, or ALL CLEAR. */
export function AlertList({ alerts, dealing, onTable }: Props) {
  const t = useT();
  const navigate = useNavigate();
  const { can } = useSession();
  if (alerts.length === 0) {
    return (
      <div className="card insp-clear">
        <strong>{t('insp_all_clear')}</strong>
        <span className="muted">{t('insp_all_clear_sub', { n: dealing })}</span>
      </div>
    );
  }

  function act(alert: FloorAlert) {
    const { action } = alertView(alert);
    if (action === 'change_level') navigate('/club/account');
    if (action === 'open_requests') navigate('/club/requests');
    if (action === 'open_simulation') navigate('/inspector/simulation');
    if (action === 'open_tournaments') navigate('/inspector/tournaments');
    if (action === 'assign_dealer' && alert.tableId) onTable(alert.tableId, 'assign');
    if (action === 'open_table' && alert.tableId) onTable(alert.tableId, 'menu');
  }

  return (
    <section className="stack">
      <span className="section-title">{t('insp_needs_you', { n: alerts.length })}</span>
      {alerts.map((a, i) => {
        const view = alertView(a);
        const showAction = view.action && (view.action !== 'change_level' || can('billing'));
        return (
          <div key={`${a.code}-${a.tableId ?? a.tournamentId ?? i}`} className={`insp-alert ${a.severity}`}>
            <span className="grow">{t(view.key, alertParams(a, t))}</span>
            {showAction && <button type="button" className="btn ghost" onClick={() => act(a)}>{t(`insp_action_${view.action}`)}</button>}
          </div>
        );
      })}
    </section>
  );
}
