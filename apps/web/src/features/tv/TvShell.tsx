import { useEffect, type ReactNode } from 'react';
import { useT } from '../../i18n/i18n';
import type { TvConnection } from './useTvSocket';
import './tv.css';

interface WakeLockSentinelLike { release(): Promise<void> }
interface WakeLockNavigator { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }

/** Keeps the TV screen from sleeping while a display is shown (when the browser allows it). */
function useWakeLock(): void {
  useEffect(() => {
    let lock: WakeLockSentinelLike | null = null;
    let alive = true;
    const request = () => {
      (navigator as unknown as WakeLockNavigator).wakeLock?.request('screen')
        .then((l) => { if (alive) lock = l; else void l.release(); })
        .catch(() => { /* not allowed on this device */ });
    };
    request();
    const onVisible = () => { if (document.visibilityState === 'visible') request(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

/** Full-screen landscape frame for every TV screen. */
export function TvShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  useWakeLock();
  return <div className={`tv-root ${className}`}>{children}</div>;
}

export function LiveBadge({ connection }: { connection: TvConnection }) {
  const t = useT();
  return connection === 'live'
    ? <span className="badge live tv-badge">{t('tv_live')}</span>
    : <span className="badge open tv-badge">{t('tv_reconnecting')}</span>;
}

/** Shown when the display token ran out or staff disconnected the TV. */
export function TvEnded({ reason, onPairAgain }: { reason: 'expired' | 'revoked'; onPairAgain: () => void }) {
  const t = useT();
  return (
    <TvShell className="tv-center">
      <div className="tv-message">
        <h1>{t(reason === 'revoked' ? 'tv_revoked_title' : 'tv_expired_title')}</h1>
        <p className="muted">{t('tv_expired_body')}</p>
        <button type="button" className="btn primary lg" onClick={onPairAgain} autoFocus>{t('tv_pair_again')}</button>
      </div>
    </TvShell>
  );
}
