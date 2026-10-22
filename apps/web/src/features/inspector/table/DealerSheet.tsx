import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { Empty, Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { useSession } from '../../../state/session';
import { INSP, useDealers, type Dealer } from '../api';

interface Props {
  open: boolean;
  onClose: () => void;
  table: { id: string; name: string };
  /** open: opens the table with the dealer; assign: seats a dealer on an open table. */
  mode: 'open' | 'assign';
}

function dealerNote(d: Dealer, tableId: string, t: ReturnType<typeof useT>): string | null {
  if (d.assignedTableId && d.assignedTableId !== tableId) return t('insp_dealer_already_on', { table: d.assignedTable ?? '' });
  if (d.busyElsewhere) return t('insp_dealer_elsewhere');
  return null;
}

/** Dealer picker: club dealers, "Me — I'll deal" for owner/manager, and the stand-up-elsewhere confirm. */
export function DealerSheet({ open, onClose, table, mode }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user, can } = useSession();
  const dealers = useDealers(open);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfDone, setSelfDone] = useState(false);
  const list = dealers.data ?? [];
  const canSelf = can('settings') && user && !list.some((d) => d.id === user.id);
  const picked = list.find((d) => d.id === chosen);
  const movesFrom = picked?.assignedTableId && picked.assignedTableId !== table.id ? picked.assignedTable : null;

  const close = () => { setChosen(null); setSelfDone(false); onClose(); };

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    try {
      if (mode === 'open') {
        await api.put(`/inspector/table/${table.id}/open`, { dealerId: chosen, leaveHeld: Boolean(movesFrom) });
        toast.show(t('insp_toast_opened'), 'success');
      } else {
        await api.post(`/inspector/table/${table.id}/assign`, { dealerId: chosen });
        toast.show(t('insp_toast_assigned'), 'success');
      }
      await qc.invalidateQueries({ queryKey: [INSP] });
      if (chosen === user?.id) setSelfDone(true);
      else close();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (selfDone) {
    return (
      <Sheet open={open} onClose={close} title={t('insp_self_deal_title', { table: table.name })}>
        <p className="muted">{t('insp_self_deal_body')}</p>
        <button type="button" className="btn primary block" onClick={() => { close(); navigate(`/dealer/table/${table.id}`); }}>{t('insp_dealer_screen')}</button>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onClose={close} title={t(mode === 'open' ? 'insp_open_title' : 'insp_assign_title', { table: table.name })}>
      {dealers.isLoading && <Spinner />}
      {!dealers.isLoading && list.length === 0 && !canSelf && <Empty title={t('insp_no_dealer_yet')} />}
      <div className="list" role="radiogroup">
        {list.map((d) => {
          const note = dealerNote(d, table.id, t);
          return (
            <label key={d.id} className="list-row insp-choice">
              <input type="radio" name="dealer" checked={chosen === d.id} onChange={() => setChosen(d.id)} />
              <span className="grow">
                <strong>{d.displayName}</strong> <span className="faint">@{d.username}</span>
                {note && <span className="muted insp-sub">{note}</span>}
              </span>
            </label>
          );
        })}
        {canSelf && user && (
          <label className="list-row insp-choice">
            <input type="radio" name="dealer" checked={chosen === user.id} onChange={() => setChosen(user.id)} />
            <span className="grow">
              <strong>{t('insp_me_deal')}</strong>
              <span className="muted insp-sub">{t('insp_me_deal_note')}</span>
            </span>
          </label>
        )}
      </div>
      {movesFrom && mode === 'open' && <div className="banner">{t('insp_dealer_moves', { table: movesFrom })}</div>}
      <button type="button" className="btn primary block" disabled={!chosen || busy} onClick={() => void submit()}>
        {t(mode === 'open' ? 'insp_open_confirm' : 'insp_assign_confirm')}
      </button>
    </Sheet>
  );
}
