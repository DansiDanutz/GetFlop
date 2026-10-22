import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { Spinner } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { amount } from '../../../lib/format';
import { INSP, type ClosePreview } from '../api';

interface Props { open: boolean; onClose: () => void; table: { id: string; name: string } }

/** Close with the refund preview (07 §2.3). Blocked while a hand is live. */
export function CloseSheet({ open, onClose, table }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: [INSP, 'close-preview', table.id],
    queryFn: () => api.get<ClosePreview>(`/inspector/table/${table.id}/close-preview`),
    enabled: open,
    staleTime: 0,
  });
  const p = preview.data;

  async function confirm() {
    setBusy(true);
    try {
      await api.put(`/inspector/table/${table.id}/close`);
      toast.show(t('insp_toast_closed', { table: table.name }), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const isTournament = p?.table.kind === 'tournament';
  return (
    <Sheet open={open} onClose={onClose} title={t('insp_close_title', { table: table.name })} modal>
      {preview.isLoading && <Spinner />}
      {preview.isError && <div className="banner danger">{t('insp_load_failed')}</div>}
      {p && p.hasActiveHand && <div className="banner danger">{t('insp_close_hand_live', { hand: p.activeHandNumber ?? '' })}</div>}
      {p && !p.hasActiveHand && isTournament && (
        <div className="stack">
          <p className="muted">{t('insp_close_tournament')}</p>
          {p.tournamentRunning && <p className="muted">{t('insp_close_tournament_running', { name: p.tournamentName ?? '' })}</p>}
        </div>
      )}
      {p && !p.hasActiveHand && !isTournament && p.couponCount === 0 && <p className="muted">{t('insp_close_nothing')}</p>}
      {p && !p.hasActiveHand && !isTournament && p.couponCount > 0 && (
        <div className="stack">
          <div className="insp-headline">{amount(p.totalRefundCents)}</div>
          <p className="muted">{t('insp_close_counts', { c: p.couponCount, p: p.playerCount })}</p>
          <div className="list">
            {p.coupons.map((c) => (
              <div key={c.couponId} className="list-row">
                <span className="grow">{c.player}</span>
                <span className="faint">{t('insp_flops_left', { n: c.drawsLeft })}</span>
                <strong className="num">{amount(c.refundCents)}</strong>
              </div>
            ))}
          </div>
          <p className="faint">{t('insp_close_refund_rule')}</p>
        </div>
      )}
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>{t('insp_cancel')}</button>
        <button type="button" className="btn danger" disabled={!p || p.hasActiveHand || busy} onClick={() => void confirm()}>
          {p && p.totalRefundCents > 0 && !isTournament ? t('insp_close_refund', { amount: amount(p.totalRefundCents) }) : t('insp_close_confirm')}
        </button>
      </div>
    </Sheet>
  );
}
