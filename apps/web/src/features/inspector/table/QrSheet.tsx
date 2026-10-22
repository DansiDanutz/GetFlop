import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ConfirmSheet, Sheet } from '../../../components/Sheet';
import { useToast } from '../../../components/Toast';
import { QrCode } from '../../../components/ui';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { useSession } from '../../../state/session';
import { INSP } from '../api';

interface Props { open: boolean; onClose: () => void; table: { id: string; name: string; joinCode: string } }

export const joinUrl = (code: string): string => `${window.location.origin}/#/join/${code}`;

/** Table QR with its join code; owner or manager may regenerate it (old prints stop working). */
export function QrSheet({ open, onClose, table }: Props) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { can } = useSession();
  const [code, setCode] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = code ?? table.joinCode;

  async function regenerate() {
    setBusy(true);
    try {
      const { joinCode } = await api.post<{ joinCode: string }>(`/tables/${table.id}/generate-code`);
      setCode(joinCode);
      setConfirming(false);
      toast.show(t('insp_qr_regenerated'), 'success');
      await qc.invalidateQueries({ queryKey: [INSP] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Sheet open={open && !confirming} onClose={onClose} title={t('insp_qr_title', { table: table.name })}>
        <div className="center stack">
          <QrCode text={joinUrl(current)} size={240} />
          <div className="insp-code">{current}</div>
          <span className="faint insp-break">{joinUrl(current)}</span>
        </div>
        {can('limits.edit') && (
          <button type="button" className="btn ghost block" onClick={() => setConfirming(true)}>{t('insp_qr_regenerate')}</button>
        )}
      </Sheet>
      <ConfirmSheet
        open={open && confirming} title={t('insp_qr_regenerate')} body={t('insp_qr_regenerate_warn')}
        confirmLabel={t('insp_qr_regenerate')} cancelLabel={t('insp_cancel')} danger busy={busy}
        onConfirm={() => void regenerate()} onCancel={() => setConfirming(false)}
      />
    </>
  );
}
