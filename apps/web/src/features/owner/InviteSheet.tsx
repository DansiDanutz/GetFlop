import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { QrCode, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { ownerApi } from './api';

/** The link a QR or share carries: the app's own origin, invite route (03 §7). */
export const inviteLink = (publicId: string, origin = window.location.origin): string => `${origin}/#/c/${publicId}`;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function InviteBody({ clubId }: { clubId: string }) {
  const t = useT();
  const toast = useToast();
  const settings = useQuery({ queryKey: ['owner', 'settings', clubId], queryFn: () => ownerApi.settings(clubId) });
  if (settings.isLoading || !settings.data) return <Spinner />;
  const { name, publicId } = settings.data;
  const link = inviteLink(publicId);
  const shareText = t('own_invite_share_text', { club: name });
  const shared = () => void ownerApi.inviteShared(clubId).catch(() => undefined);

  async function copyValue(value: string, label: string) {
    if (await copy(value)) { toast.show(t('own_copied', { what: label }), 'success'); shared(); } else toast.show(t('own_copy_failed'), 'error');
  }
  async function shareLink() {
    if (!navigator.share) return copyValue(link, t('own_invite_link'));
    try { await navigator.share({ title: name, text: shareText, url: link }); shared(); } catch { /* the user closed the share sheet */ }
  }
  async function shareQr() {
    try {
      const blob = await (await fetch(await QRCode.toDataURL(link, { width: 720, margin: 2 }))).blob();
      const file = new File([blob], `club-${publicId}.png`, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text: shareText }); shared(); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
      shared();
    } catch { toast.show(t('own_share_failed'), 'error'); }
  }

  return (
    <div className="stack own-qr">
      <strong style={{ fontSize: 20 }}>{name}</strong>
      <button type="button" className="btn link" onClick={() => void copyValue(publicId, t('own_club_id_label'))}>
        {t('own_club_id', { id: publicId })} ⧉
      </button>
      <QrCode text={link} size={220} />
      <p className="muted center">{t('own_invite_hint')}</p>
      <div className="stack" style={{ width: '100%' }}>
        <button type="button" className="btn primary block" onClick={() => void shareLink()}>{t('own_invite_send_link')}</button>
        <button type="button" className="btn ghost block" onClick={() => void shareQr()}>{t('own_invite_send_qr')}</button>
        <button type="button" className="btn ghost block" onClick={() => void copyValue(link, t('own_invite_link'))}>{t('own_invite_copy_link')}</button>
      </div>
    </div>
  );
}

export function InviteSheet({ open, onClose, clubId }: { open: boolean; onClose: () => void; clubId: string }) {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t('own_invite_title')}>
      {open && <InviteBody clubId={clubId} />}
    </Sheet>
  );
}
