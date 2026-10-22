import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { amount } from '../../lib/format';
import { useSocketEvent } from '../../lib/socket';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { captureInstallPrompt, useInstall } from './install';
import { clearSessionEnded, endedCopy, useSessionEnded } from './sessionEnded';
import { KEYS, readFlag, setFlag } from './storage';
import { Welcome } from './Welcome';
import './me.css';

captureInstallPrompt();

interface RequestActioned { type: string; status: string; amountCents: number }

/** Mounted once in App: session-ended screen, welcome cards, install prompt, Points request receipts. */
export function MeOverlays() {
  const { user } = useSession();
  return (
    <>
      <SessionEndedScreen />
      {user && <Welcome />}
      {user && <RequestReceipts />}
      {user && <InstallBanner />}
    </>
  );
}

function SessionEndedScreen() {
  const t = useT();
  const navigate = useNavigate();
  const info = useSessionEnded();
  if (!info) return null;
  const copy = endedCopy(info);
  const again = () => { clearSessionEnded(); navigate('/login', { replace: true }); };
  return (
    <div className="me-ended" role="alertdialog" aria-modal="true" aria-labelledby="me-ended-title">
      <div className="card stack-lg">
        <div className="icon" aria-hidden>{info.reason === 'other_device' ? '♠' : '♦'}</div>
        <h1 id="me-ended-title">{t(copy.title, { device: copy.device ? t(copy.device) : '' })}</h1>
        <p className="muted">{t(copy.body)}</p>
        <button type="button" className="btn primary block lg" onClick={again}>{t('me_ended_signin')}</button>
      </div>
    </div>
  );
}

/** request:actioned → a receipt toast and fresh balances/requests. */
function RequestReceipts() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  useSocketEvent<RequestActioned>('request:actioned', (p) => {
    const side = p.type === 'cashout' ? 'return' : 'request';
    const approved = p.status === 'approved';
    toast.show(t(`me_receipt_${side}_${approved ? 'approved' : 'declined'}`, { amount: amount(p.amountCents) }), approved ? 'success' : 'info');
    void qc.invalidateQueries({ queryKey: ['my'] });
  }, [toast, qc]);
  return null;
}

/** "Install GetFlop" on the clubs home: Chromium prompt, or iOS Add-to-Home-Screen steps. */
function InstallBanner() {
  const t = useT();
  const location = useLocation();
  const install = useInstall();
  const [dismissed, setDismissed] = useState(() => readFlag(KEYS.installDismissed));
  const [iosOpen, setIosOpen] = useState(false);
  useEffect(() => { if (install.installed) setDismissed(true); }, [install.installed]);
  const offer = install.canPrompt || install.ios;
  if (dismissed || install.installed || !offer || location.pathname !== '/clubs') return null;
  const notNow = () => { setFlag(KEYS.installDismissed, true); setDismissed(true); };
  const go = async () => {
    if (install.canPrompt) { if (await install.prompt()) setDismissed(true); }
    else setIosOpen(true);
  };
  return (
    <>
      <div className="me-install card row" role="region" aria-label={t('me_install_title')}>
        <img src="/mark.svg" width={36} height={36} alt="" />
        <span className="grow">
          <strong style={{ display: 'block' }}>{t('me_install_title')}</strong>
          <span className="faint">{t('me_install_sub')}</span>
        </span>
        <button type="button" className="btn ghost" onClick={notNow}>{t('me_install_not_now')}</button>
        <button type="button" className="btn primary" onClick={() => void go()}>{t('me_install_cta')}</button>
      </div>
      <IosInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
    </>
  );
}

export function IosInstallSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t('me_install_ios_title')}>
      <ol className="me-steps">
        <li>{t('me_install_ios_1')}</li>
        <li>{t('me_install_ios_2')}</li>
        <li>{t('me_install_ios_3')}</li>
      </ol>
      <button type="button" className="btn primary block" onClick={onClose}>{t('done')}</button>
    </Sheet>
  );
}
