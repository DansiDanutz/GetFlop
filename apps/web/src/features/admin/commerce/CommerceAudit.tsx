import { useState } from 'react';
import { useT } from '../../../i18n/i18n';
import { dateTime } from '../../../lib/format';
import { useAdmin } from '../api';
import { labelOr, Loadable } from '../parts';
import { COMMERCE_BASE, type CommerceAuditPage } from './types';

const PAGE_SIZE = 50;

export function CommerceAuditTab() {
  const t = useT();
  const [page, setPage] = useState(1);
  const query = useAdmin<CommerceAuditPage>(['commerce', 'audit', page], `${COMMERCE_BASE}/audit?page=${page}`);
  return (
    <Loadable query={query} empty={(d) => d.entries.length === 0}>
      {(d) => {
        const pages = Math.max(1, Math.ceil(d.total / PAGE_SIZE));
        return (
          <div className="stack">
            {d.entries.map((e) => (
              <div key={e.id} className="card tight row-card">
                <div className="row-between"><strong>{labelOr(`admin_commerce_action_${e.action}`, e.action)}</strong><span className="faint">{dateTime(e.createdAt)}</span></div>
                <span className="meta">{t('admin_audit_by', { name: e.actor ?? '—' })}{e.entityType ? ` · ${e.entityType} ${e.entityId ?? ''}` : ''}</span>
                {Object.keys(e.data).length > 0 && <span className="mono">{JSON.stringify(e.data)}</span>}
              </div>
            ))}
            <div className="pager">
              <button type="button" className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('admin_newer')}</button>
              <span className="muted">{t('admin_page_of', { page, pages, total: d.total })}</span>
              <button type="button" className="btn ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>{t('admin_older')}</button>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}
