import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { Spinner } from '../../../components/ui';
import { errorMessage, useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { INSP, type DeletePreview } from '../api';

interface Props { open: boolean; onClose: () => void; onDone?: () => void; table: { id: string; name: string } }

/** Delete for good (never played) or archive (history kept), with the server's blockers (07 §2.4). */
export function DeleteSheet({ open, onClose, onDone, table }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: [INSP, 'delete-preview', table.id],
    queryFn: () => api.get<DeletePreview>(`/inspector/table/${table.id}/delete-preview`),
    enabled: open,
    staleTime: 0,
  });
  const p = preview.data;

  async function confirm() {
    if (!p) return;
    setBusy(true);
    try {
      await api.del(`/inspector/table/${table.id}`, { expectMode: p.mode });
      toast.show(t(p.mode === 'delete' ? 'insp_toast_deleted' : 'insp_toast_archived', { table: table.name }), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      onClose();
      onDone?.();
    } catch (err) {
      toast.error(err);
      await preview.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('insp_delete_title', { table: table.name })} modal>
      {preview.isLoading && <Spinner />}
      {preview.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {p?.blocked && <div className="banner danger">{errorMessage(p.blocked.code, p.blocked.params)}</div>}
      {p && !p.blocked && (
        <div className="stack">
          <p>{t(p.mode === 'delete' ? 'insp_delete_forever' : 'insp_delete_archive')}</p>
          {p.mode === 'archive' && <p className="muted">{t('insp_delete_history', { hands: p.history.hands, coupons: p.history.coupons })}</p>}
          {p.dealer && <p className="muted">{t('insp_delete_dealer', { name: p.dealer.name })}</p>}
        </div>
      )}
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('insp_cancel')}</button>
        <button type="button" className="btn danger" disabled={!p || Boolean(p.blocked) || busy} onClick={() => void confirm()}>
          {t(p?.mode === 'archive' ? 'insp_archive_confirm' : 'insp_delete_confirm')}
        </button>
      </div>
    </Sheet>
  );
}
