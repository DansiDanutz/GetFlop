import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { QrCode, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { ownerApi } from './api';
import './owner.css';

const SECOND = 1_000;

interface WakeLockLike { release(): Promise<void> }
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };

/** Keeps the screen on while the code is shown (best effort). */
function useWakeLock(): void {
  useEffect(() => {
    let lock: WakeLockLike | null = null;
    let alive = true;
    (navigator as NavigatorWithWakeLock).wakeLock?.request('screen')
      .then((l) => { if (alive) lock = l; else void l.release(); })
      .catch(() => undefined);
    return () => { alive = false; void lock?.release().catch(() => undefined); };
  }, []);
}

/** "My code" (#/me/code): the rotating signed QR staff scan at the desk (03 §6). */
export function MyCodePage() {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useSession();
  const [left, setLeft] = useState(0);
  const code = useQuery({
    queryKey: ['owner', 'player-code'],
    queryFn: () => ownerApi.playerCode(),
    refetchInterval: (q) => Math.max(1, q.state.data?.rotatesInSeconds ?? 60) * SECOND,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });
  useWakeLock();
  useEffect(() => {
    if (!code.data) return;
    const until = Date.now() + code.data.rotatesInSeconds * SECOND;
    const tick = () => setLeft(Math.max(0, Math.ceil((until - Date.now()) / SECOND)));
    tick();
    const timer = setInterval(tick, SECOND);
    return () => clearInterval(timer);
  }, [code.data]);

  const link = code.data ? `${window.location.origin}/#/pc/${code.data.code}` : '';
  return (
    <div className="screen">
      <TopBar />
      <div className="screen-body">
        <button type="button" className="btn link" style={{ justifySelf: 'start' }} onClick={() => navigate(-1)}>← {t('back')}</button>
        <h1>{t('own_my_code_title')}</h1>
        <p className="muted">{t('own_my_code_hint')}</p>
        <div className="card own-qr">
          {code.isLoading && <Spinner />}
          {code.isError && <div className="banner danger">{t('own_my_code_offline')}</div>}
          {code.data && !code.isError && (
            <>
              <QrCode text={link} size={260} />
              <strong>{user?.displayName}</strong>
              <span className="own-code-clock">{t('own_my_code_rotates', { s: left })}</span>
            </>
          )}
        </div>
        <p className="own-note center">{t('own_my_code_photo')}</p>
      </div>
    </div>
  );
}
