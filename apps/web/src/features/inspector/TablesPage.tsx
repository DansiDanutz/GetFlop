import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useTables, type TableView } from './api';
import { StaffFrame } from './StaffFrame';
import { CreateTableSheet } from './table/CreateTableSheet';
import { TableActions, type TableAction } from './table/TableActions';

const STATUS_CLASS: Record<string, string> = { open: 'live', closed: '' };

/** /club/tables — every table of the club, create, and the table sheet. */
export function TablesPage() {
  const t = useT();
  const navigate = useNavigate();
  const tables = useTables();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<{ table: TableView; action: TableAction } | null>(null);
  const list = tables.data ?? [];
  return (
    <StaffFrame>
      <div className="row-between">
        <h1>{t('insp_tables_title')}</h1>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>{t('insp_new_table')}</button>
      </div>
      {tables.isLoading && <Spinner />}
      {tables.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {tables.data && list.length === 0 && <Empty icon="▦" title={t('insp_no_tables')} />}
      <div className="card tight list">
        {list.map((tb) => (
          <div key={tb.id} className="list-row">
            <button type="button" className="grow insp-rowbtn" onClick={() => navigate(`/club/tables/${tb.id}`)}>
              <strong>{tb.name}</strong>
              <span className="muted insp-sub">
                {t(`insp_game_${tb.game}`)} · {tb.dealerName ? t('insp_dealt_by', { name: tb.dealerName }) : t('insp_no_dealer')}
                {tb.markets.length > 0 ? ` · ${t('insp_markets_count', { k: tb.markets.length, n: tb.offered.length || tb.markets.length })}` : ''}
              </span>
            </button>
            <span className={`badge ${STATUS_CLASS[tb.status] ?? ''}`}>{t(`insp_status_${tb.status}`)}</span>
            <button type="button" className="icon-btn" aria-label={t('insp_more')} onClick={() => setSelected({ table: tb, action: 'menu' })}>⋯</button>
          </div>
        ))}
      </div>
      <TableActions table={selected?.table ?? null} action={selected?.action ?? null}
        onChange={(action) => setSelected((s) => (s && action ? { ...s, action } : null))} />
      <CreateTableSheet open={creating} onClose={() => setCreating(false)} />
    </StaffFrame>
  );
}
