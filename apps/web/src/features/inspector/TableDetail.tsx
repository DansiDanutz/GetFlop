import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { Empty, QrCode, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { useSession } from '../../state/session';
import { INSP, useCatalogue, useTables } from './api';
import { initialSelection, selectionPayload } from './model/limits';
import { StaffFrame } from './StaffFrame';
import { LimitsEditor } from './table/LimitsEditor';
import { MarketsPicker } from './table/MarketsPicker';
import { joinUrl } from './table/QrSheet';
import { TableActions, type TableAction } from './table/TableActions';

/** /club/tables/:id — name, lobby card, markets, limits and QR of one table. */
export function TableDetail() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();
  const { can } = useSession();
  const tables = useTables();
  const catalogue = useCatalogue();
  const table = tables.data?.find((x) => x.id === id);
  const markets = catalogue.data ?? [];
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<TableAction | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (table) setName(table.name); }, [table?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (table && markets.length) setSelected(initialSelection(table.markets, markets)); }, [table?.markets, markets]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast.show(t('insp_saved'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (tables.isLoading) return <StaffFrame><Spinner /></StaffFrame>;
  if (!table) {
    return (
      <StaffFrame>
        <Empty title={t('err_table_not_found')}><button type="button" className="btn ghost" onClick={() => navigate('/club/tables')}>{t('insp_back')}</button></Empty>
      </StaffFrame>
    );
  }
  const isTournament = table.kind === 'tournament';

  return (
    <StaffFrame>
      <div className="row-between">
        <button type="button" className="btn link" onClick={() => navigate('/club/tables')}>← {t('insp_back')}</button>
        <button type="button" className="icon-btn" aria-label={t('insp_more')} onClick={() => setAction('menu')}>⋯</button>
      </div>
      <section className="card stack">
        <label className="stack">
          <span className="eyebrow">{t('insp_table_name')}</span>
          <input value={name} maxLength={40} placeholder={t('insp_table_name_ph')} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" className="btn ghost" disabled={busy || !name.trim() || name.trim() === table.name}
          onClick={() => void run(() => api.put(`/inspector/table/${table.id}`, { name: name.trim() }))}>{t('insp_save_name')}</button>
        {!isTournament && (
          <div className={`insp-card-preview${table.photoUrl ? '' : ' felt'}`} style={table.photoUrl ? { backgroundImage: `url(${table.photoUrl})` } : undefined}>
            <strong>{table.name}</strong>
            <span className="pill">{t(`insp_game_${table.game}`)}{table.featured ? ` · ${t('insp_featured')}` : ''}</span>
          </div>
        )}
        {!isTournament && <button type="button" className="btn ghost" onClick={() => setAction('card')}>{t('insp_act_card')}</button>}
      </section>
      {!isTournament && (
        <section className="card stack">
          <span className="section-title">{t('insp_allowed_markets')}</span>
          <MarketsPicker markets={markets} selected={selected} onChange={setSelected} />
          <button type="button" className="btn primary block" disabled={busy || selected.size === 0}
            onClick={() => void run(() => api.put(`/inspector/table/${table.id}/bet-types`, { allowedBetTypeIds: selectionPayload(selected, markets) }))}>
            {t('insp_save_markets')}
          </button>
        </section>
      )}
      {!isTournament && <LimitsEditor table={table} markets={markets} canEdit={can('limits.edit')} />}
      <section className="card stack center">
        <span className="section-title">{t('insp_act_qr')}</span>
        <QrCode text={joinUrl(table.joinCode)} size={180} />
        <div className="insp-code">{table.joinCode}</div>
        {can('limits.edit') && <button type="button" className="btn ghost" onClick={() => setAction('qr')}>{t('insp_qr_regenerate')}</button>}
      </section>
      <TableActions table={{ ...table }} action={action} onChange={setAction} />
    </StaffFrame>
  );
}
