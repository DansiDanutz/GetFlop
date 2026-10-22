import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmSheet, Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { TvLaunchSheet } from '../../tv';
import { INSP } from '../api';
import { CloseSheet } from './CloseSheet';
import { DealerSheet } from './DealerSheet';
import { DeleteSheet } from './DeleteSheet';
import { LobbyCardSheet } from './LobbyCardSheet';
import { QrSheet } from './QrSheet';

export interface ActionTable {
  id: string;
  name: string;
  status: string;
  kind: string;
  dealerId: string | null;
  dealerName: string | null;
  isAutoDeal: boolean;
  joinCode: string;
  game: string;
  featured: boolean;
  photoUrl?: string | null;
}

export type TableAction = 'menu' | 'open' | 'assign' | 'close' | 'unseat' | 'card' | 'qr' | 'tv' | 'delete';

interface Props {
  table: ActionTable | null;
  /** Which sheet to show; null = none. */
  action: TableAction | null;
  onChange: (action: TableAction | null) => void;
}

/** The table sheet ("⋯") and every sheet it opens (07 §2.5). */
export function TableActions({ table, action, onChange }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<ActionTable | null>(table);
  useEffect(() => { if (table) setLast(table); }, [table]);
  const tb = table ?? last;
  if (!tb) return null;
  const close = () => onChange(null);
  const isOpen = tb.status === 'open';
  const isTournament = tb.kind === 'tournament';

  async function openAuto() {
    setBusy(true);
    try {
      await api.put(`/inspector/table/${tb!.id}/open`, {});
      toast.show(t('insp_toast_opened'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      close();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function unseat() {
    setBusy(true);
    try {
      await api.post(`/inspector/table/${tb!.id}/unseat`);
      toast.show(t('insp_toast_unseated'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      close();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  const item = (key: string, next: TableAction | (() => void), danger = false) => (
    <button key={key} type="button" className={`btn ${danger ? 'ghost insp-danger-text' : 'ghost'} block`}
      onClick={() => (typeof next === 'function' ? next() : onChange(next))}>{t(key)}</button>
  );

  return (
    <>
      <Sheet open={action === 'menu'} onClose={close} title={tb.name}>
        <div className="stack">
          {!isOpen && (tb.isAutoDeal ? item('insp_act_open', () => void openAuto()) : item('insp_act_open', 'open'))}
          {isOpen && item('insp_act_close', 'close')}
          {isOpen && !tb.dealerId && !tb.isAutoDeal && item('insp_act_assign', 'assign')}
          {isOpen && tb.dealerId && item('insp_act_unseat', 'unseat')}
          {!isTournament && item('insp_act_markets', () => { close(); navigate(`/club/tables/${tb.id}`); })}
          {!isTournament && item('insp_act_card', 'card')}
          {item('insp_act_qr', 'qr')}
          {!isTournament && item('insp_act_tv', 'tv')}
          {item('insp_act_delete', 'delete', true)}
        </div>
      </Sheet>
      <DealerSheet open={action === 'open' || action === 'assign'} mode={action === 'assign' ? 'assign' : 'open'} table={tb} onClose={close} />
      <CloseSheet open={action === 'close'} table={tb} onClose={close} />
      <ConfirmSheet
        open={action === 'unseat'} title={t('insp_unseat_title', { name: tb.dealerName ?? '' })} body={t('insp_unseat_body')}
        confirmLabel={t('insp_act_unseat')} cancelLabel={t('insp_cancel')} busy={busy} onConfirm={() => void unseat()} onCancel={close}
      />
      <LobbyCardSheet open={action === 'card'} table={tb} onClose={close} />
      <QrSheet open={action === 'qr'} table={tb} onClose={close} />
      <TvLaunchSheet open={action === 'tv'} onClose={close} kind="cash" targetId={tb.id} targetName={tb.name} />
      <DeleteSheet open={action === 'delete'} table={tb} onClose={close} />
    </>
  );
}
