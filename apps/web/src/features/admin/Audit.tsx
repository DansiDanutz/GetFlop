import { useState } from 'react';
import { useT } from '../../i18n/i18n';
import { qs } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { AdminShell } from './AdminShell';
import { useAdmin, type AuditLog, type AuditPage } from './api';
import { auditActionKey } from './logic';
import { labelOr, Loadable } from './parts';

const PAGE_SIZE = 50;

/** Localised `audit_action_<action>`, or the raw action when there is no translation. */
export function AuditActionLabel({ action }: { action: string }) {
  return <strong>{labelOr(auditActionKey(action), action)}</strong>;
}

function details(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

function Entry({ log }: { log: AuditLog }) {
  const t = useT();
  const on = log.targetName ?? log.clubName ?? log.targetId;
  return (
    <div className="card tight row-card">
      <div className="row-between"><AuditActionLabel action={log.action} /><span className="faint">{dateTime(log.createdAt)}</span></div>
      <span className="meta">{t('admin_audit_by', { name: log.actorName ?? '—' })}{on ? ` · ${t('admin_audit_on', { target: on })}` : ''}</span>
      {Object.keys(log.data).length > 0 && <span className="mono">{details(log.data)}</span>}
    </div>
  );
}

export function AuditView() {
  const t = useT();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const query = useAdmin<AuditPage>(['audit', page, action], `/admin/audit${qs({ page, limit: PAGE_SIZE, action })}`);
  const actions = query.data?.actions ?? [];
  return (
    <div className="stack">
      <h1>{t('admin_audit_title')}</h1>
      <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label={t('admin_audit_filter')}>
        <option value="">{t('admin_audit_all_actions')}</option>
        {actions.map((a) => <option key={a} value={a}>{labelOr(auditActionKey(a), a)}</option>)}
      </select>
      <Loadable query={query} empty={(d) => d.logs.length === 0}>
        {(d) => (
          <div className="stack">
            {d.logs.map((log) => <Entry key={log.id} log={log} />)}
            <div className="pager">
              <button type="button" className="btn ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('admin_newer')}</button>
              <span className="muted">{t('admin_page_of', { page: d.pagination.page, pages: d.pagination.totalPages, total: d.pagination.total })}</span>
              <button type="button" className="btn ghost" disabled={page >= d.pagination.totalPages} onClick={() => setPage(page + 1)}>{t('admin_older')}</button>
            </div>
          </div>
        )}
      </Loadable>
    </div>
  );
}

export function AuditScreen() {
  return <AdminShell><AuditView /></AdminShell>;
}
