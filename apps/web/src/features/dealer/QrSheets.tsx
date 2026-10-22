import { Sheet } from '../../components/Sheet';
import { QrCode } from '../../components/ui';
import { useT } from '../../i18n/i18n';

const QR_SIZE = 240;

/** Players scan this to open the table: `${origin}/#/join/<joinCode>`. */
export function tableJoinLink(joinCode: string, origin = window.location.origin): string {
  return `${origin}/#/join/${joinCode}`;
}

export function TableQrSheet({ open, onClose, tableName, joinCode }: { open: boolean; onClose: () => void; tableName: string; joinCode: string }) {
  const t = useT();
  const link = tableJoinLink(joinCode);
  return (
    <Sheet open={open} onClose={onClose} title={t('dealer_table_qr_title', { table: tableName })}>
      <div className="qr-block">
        <QrCode text={link} size={QR_SIZE} />
        <p className="muted">{t('dealer_table_qr_sub')}</p>
        <code className="faint">{link}</code>
      </div>
    </Sheet>
  );
}

export function AppQrSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const link = `${window.location.origin}/`;
  return (
    <Sheet open={open} onClose={onClose} title={t('dealer_app_qr_title')}>
      <div className="qr-block">
        <QrCode text={link} size={QR_SIZE} />
        <p className="muted">{t('dealer_app_qr_sub')}</p>
      </div>
    </Sheet>
  );
}
