import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n/i18n';
import { LanguageSwitch } from '../features/auth/Login';
import { useSession, type Surface } from '../state/session';
import { Sheet } from './Sheet';

export const SURFACE_HOME: Record<Surface, string> = {
  player: '/player', dealer: '/dealer', inspector: '/inspector', club: '/club/tables',
};

interface TopBarProps {
  /** Right-side status (e.g. picks badge). */
  status?: ReactNode;
  onHelp?: () => void;
  /** Extra menu entries for this screen. */
  menu?: ReactNode;
  subtitle?: string;
}

export function TopBar({ status, onHelp, menu, subtitle }: TopBarProps) {
  const t = useT();
  const navigate = useNavigate();
  const { context, user, logout } = useSession();
  const [open, setOpen] = useState(false);
  const club = context?.club;
  const initials = (club?.name ?? 'G').slice(0, 1).toUpperCase();
  const go = (path: string) => { setOpen(false); navigate(path); };

  return (
    <>
      <header className="topbar">
        <button type="button" className="club-chip grow" onClick={() => navigate('/clubs')} style={{ maxWidth: 260 }}>
          <span className="avatar">{club?.photoUrl ? <img src={club.photoUrl} alt="" /> : initials}</span>
          <span style={{ minWidth: 0, textAlign: 'left' }}>
            <span className="name truncate" style={{ display: 'block' }}>{club?.name ?? 'GetFlop'}</span>
            <span className="sub truncate" style={{ display: 'block' }}>{subtitle ?? user?.displayName}</span>
          </span>
          <span className="faint" aria-hidden>⌄</span>
        </button>
        <span className="spacer" />
        {status}
        {onHelp && <button type="button" className="icon-btn" aria-label={t('help')} onClick={onHelp}>?</button>}
        <button type="button" className="icon-btn square" aria-label={t('menu')} onClick={() => setOpen(true)}>☰</button>
      </header>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('menu')}>
        <div className="stack">
          {context && context.surfaces.length > 1 && (
            <div className="stack">
              <span className="eyebrow">{t('menu_switch')}</span>
              <div className="grid-2">
                {context.surfaces.map((s) => (
                  <button key={s} type="button" className="btn ghost" onClick={() => go(SURFACE_HOME[s])}>{t(`surface_${s}`)}</button>
                ))}
              </div>
            </div>
          )}
          {menu}
          <button type="button" className="btn ghost block" onClick={() => go('/clubs')}>{t('menu_my_clubs')}</button>
          <button type="button" className="btn ghost block" onClick={() => go('/account')}>{t('menu_account')}</button>
          {user?.role === 'admin' && <button type="button" className="btn ghost block" onClick={() => go('/admin')}>{t('surface_admin')}</button>}
          <div className="row-between"><span className="muted">{t('language')}</span><LanguageSwitch /></div>
          <button type="button" className="btn ghost block" onClick={() => { setOpen(false); void logout().then(() => navigate('/login')); }}>{t('logout')}</button>
        </div>
      </Sheet>
    </>
  );
}
