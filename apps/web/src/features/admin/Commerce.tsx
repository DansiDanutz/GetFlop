import { useState } from 'react';
import { Segmented } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { AdminShell } from './AdminShell';
import { CatalogueTab } from './commerce/Catalogue';
import { CodesTab } from './commerce/Codes';
import { CommerceAuditTab } from './commerce/CommerceAudit';
import { PaymentsTab } from './commerce/Payments';

type Tab = 'catalogue' | 'payments' | 'codes' | 'audit';
const TABS: readonly Tab[] = ['catalogue', 'payments', 'codes', 'audit'];

/** Platform commerce (spec 12 §10): Catalogue · Payments · Codes · Audit, over the commerce module's admin API. */
export function CommerceScreen() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('catalogue');
  return (
    <AdminShell>
      <h1>{t('admin_commerce_title')}</h1>
      <Segmented value={tab} onChange={setTab} options={TABS.map((x) => ({ value: x, label: t(`admin_commerce_tab_${x}`) }))} />
      {tab === 'catalogue' && <CatalogueTab />}
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'codes' && <CodesTab />}
      {tab === 'audit' && <CommerceAuditTab />}
    </AdminShell>
  );
}
