import type { ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QrCode } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { AdminShell } from './AdminShell';
import { useAdmin } from './api';
import { ArenaView } from './Arena';
import { AuditView } from './Audit';
import { FinanceView } from './Finance';
import { HandsView } from './Hands';
import { MarketsView } from './Markets';
import { Loadable } from './parts';

interface MoreSection { key: string; endpoint: string | null }

function AppQrView() {
  const t = useT();
  const query = useAdmin<{ data: { url: string } }>(['more', 'appqr'], '/admin/more/appqr');
  return (
    <div className="stack">
      <h1>{t('admin_appqr_title')}</h1>
      <Loadable query={query}>
        {(d) => (
          <div className="stack" style={{ justifyItems: 'center' }}>
            <p className="muted">{t('admin_appqr_note')}</p>
            <QrCode text={d.data.url} size={260} />
            <span className="mono">{d.data.url}</span>
          </div>
        )}
      </Loadable>
    </div>
  );
}

const VIEWS: Record<string, () => ReactElement> = {
  hands: () => <HandsView />,
  reconciliation: () => <FinanceView />,
  audit: () => <AuditView />,
  bettypes: () => <MarketsView />,
  arena: () => <ArenaView />,
  appqr: () => <AppQrView />,
};

export function MoreScreen() {
  const t = useT();
  const query = useAdmin<{ sections: MoreSection[] }>(['more'], '/admin/more');
  return (
    <AdminShell>
      <h1>{t('admin_more_title')}</h1>
      <Loadable query={query}>
        {(d) => (
          <div className="stack">
            {d.sections.map((s) => (
              <Link key={s.key} to={`/admin/more/${s.key}`} className="card tight row-card clickable">
                <strong>{t(`admin_more_${s.key}`)}</strong>
                <span className="meta">{t(`admin_more_${s.key}_sub`)}</span>
              </Link>
            ))}
          </div>
        )}
      </Loadable>
    </AdminShell>
  );
}

export function MoreSectionScreen() {
  const t = useT();
  const { key = '' } = useParams();
  const View = VIEWS[key];
  return (
    <AdminShell>
      <Link to="/admin/more" className="muted">← {t('admin_more_title')}</Link>
      {View ? <View /> : <p className="muted">{t('admin_nothing_here')}</p>}
    </AdminShell>
  );
}
