import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Segmented, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useDashboard } from './api';
import { AlertList } from './floor/AlertList';
import { SetupCard } from './floor/SetupCard';
import { TableRow } from './floor/TableRow';
import { groupTables, splitClosed, type FloorTable } from './model/floor';
import { StaffFrame } from './StaffFrame';
import { CreateTableSheet } from './table/CreateTableSheet';
import { TableActions, type TableAction } from './table/TableActions';

/** Tables tab → Ring Games: the floor (07 §1). */
export function Floor() {
  const t = useT();
  const navigate = useNavigate();
  const dash = useDashboard();
  const [selected, setSelected] = useState<{ table: FloorTable; action: TableAction } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [creating, setCreating] = useState(false);
  const tables = dash.data?.tables ?? [];
  const { visible, closed } = splitClosed(groupTables(tables));
  const now = Date.now();
  const onTable = (id: string, action: TableAction) => {
    const table = tables.find((x) => x.id === id);
    if (table) setSelected({ table, action });
  };

  return (
    <StaffFrame>
      <Segmented value="ring" onChange={(v) => { if (v === 'tournaments') navigate('/inspector/tournaments'); }}
        options={[{ value: 'ring', label: t('insp_seg_ring') }, { value: 'tournaments', label: t('insp_seg_tournaments') }]} />
      <SetupCard />
      {dash.isLoading && <Spinner />}
      {dash.isError && (
        <div className="banner danger row-between">
          <span>{t('insp_load_failed')}</span>
          <button type="button" className="btn link" onClick={() => void dash.refetch()}>{t('insp_retry')}</button>
        </div>
      )}
      {dash.data && <AlertList alerts={dash.data.alerts} dealing={dash.data.stats.dealing} onTable={onTable} />}
      <div className="row-between">
        <span className="section-title">{t('insp_tables_title')}</span>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>{t('insp_new_table')}</button>
      </div>
      {dash.data && tables.length === 0 && <p className="muted">{t('insp_no_tables')}</p>}
      {visible.map((g) => (
        <section key={g.group} className="stack">
          <span className="eyebrow">{t(`insp_group_title_${g.group}`)}</span>
          <div className="card tight list">
            {g.tables.map((tb) => <TableRow key={tb.id} table={tb} now={now} onAction={(a) => setSelected({ table: tb, action: a })} />)}
          </div>
        </section>
      ))}
      {closed && (
        <>
          <button type="button" className="btn ghost block" onClick={() => setShowClosed((s) => !s)}>
            {t(showClosed ? 'insp_hide_closed' : 'insp_show_closed', { n: closed.tables.length })}
          </button>
          {showClosed && (
            <div className="card tight list">
              {closed.tables.map((tb) => <TableRow key={tb.id} table={tb} now={now} onAction={(a) => setSelected({ table: tb, action: a })} />)}
            </div>
          )}
        </>
      )}
      <TableActions table={selected?.table ?? null} action={selected?.action ?? null}
        onChange={(action) => setSelected((s) => (s && action ? { ...s, action } : null))} />
      <CreateTableSheet open={creating} onClose={() => setCreating(false)} />
    </StaffFrame>
  );
}
