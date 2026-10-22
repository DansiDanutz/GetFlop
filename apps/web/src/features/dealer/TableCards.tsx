import { useT } from '../../i18n/i18n';
import { tableBadgeKey, type DealerTable, type Notice, type SitRequest } from './api';
import { noticeKey } from './DealerShell';

const BADGE_CLASS: Record<string, string> = {
  dealer_badge_open: 'live', dealer_badge_closed: 'closed', dealer_badge_picks_open: 'open', dealer_badge_dealing: 'gold',
};

function TableBadges({ table }: { table: DealerTable }) {
  const t = useT();
  const key = tableBadgeKey(table);
  const handNumber = table.currentHand?.handNumber ?? table.lastHandNumber;
  return (
    <span className="row wrap">
      <span className={`badge ${BADGE_CLASS[key] ?? ''}`}>{t(key)}</span>
      {handNumber > 0 && <span className="pill">{t('dealer_hand_n', { n: handNumber })}</span>}
      {table.tournament && <span className="pill gold-pill">{t(`dealer_tournament_${table.tournament}`)}</span>}
    </span>
  );
}

export function MyTableCard({ table, onOpen }: { table: DealerTable; onOpen: () => void }) {
  const t = useT();
  return (
    <div className="card dealer-mine stack">
      <div className="row-between">
        <strong className="table-name">{table.name}</strong>
        <span className="faint">{table.clubName}</span>
      </div>
      <TableBadges table={table} />
      <button type="button" className="btn danger block" onClick={onOpen}>{t('dealer_open_console')}</button>
    </div>
  );
}

interface AvailableProps {
  table: DealerTable;
  needsApproval: boolean;
  disabled: boolean;
  coach: boolean;
  onSit: () => void;
}

export function AvailableTableCard({ table, needsApproval, disabled, coach, onSit }: AvailableProps) {
  const t = useT();
  return (
    <div className="card tight row">
      <span className="grow stack-sm">
        <strong className="truncate">{table.name}</strong>
        <TableBadges table={table} />
      </span>
      <span className="coach-anchor">
        {coach && <span className="coach-bubble" role="note">{t('dealer_coach_sit')}</span>}
        <button type="button" className="btn primary" disabled={disabled} onClick={onSit}>
          {needsApproval ? t('dealer_ask') : t('dealer_sit')}
        </button>
      </span>
    </div>
  );
}

export function PendingPanel({ request, busy, onCancel }: { request: SitRequest; busy: boolean; onCancel: () => void }) {
  const t = useT();
  return (
    <div className="banner stack" role="status">
      <strong>{t('dealer_pending_title', { table: request.tableName })}</strong>
      <span className="muted">{t('dealer_pending_sub')}</span>
      <button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>{t('dealer_pending_cancel')}</button>
    </div>
  );
}

export function HeldPanel({ table, busy, onLeave }: { table: DealerTable; busy: boolean; onLeave: () => void }) {
  const t = useT();
  const params = { table: table.name, club: table.clubName ?? '' };
  return (
    <div className="banner danger stack">
      <strong>{t('dealer_held_title', params)}</strong>
      <button type="button" className="btn ghost" disabled={busy} onClick={onLeave}>{t('dealer_held_leave', params)}</button>
    </div>
  );
}

export function NoticeList({ notices, onRead }: { notices: readonly Notice[]; onRead: (id: string) => void }) {
  const t = useT();
  return (
    <div className="stack">
      {notices.map((n) => (
        <div key={n.id} className="banner row">
          <span className="grow">{t(noticeKey(n.code), n.params)}</span>
          <button type="button" className="btn link" onClick={() => onRead(n.id)}>{t('dealer_notice_ok')}</button>
        </div>
      ))}
    </div>
  );
}
