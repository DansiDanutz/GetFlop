import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useT } from '../../i18n/i18n';
import { loadDisplay } from './storage';
import { TvShell } from './TvShell';

/** #/tv: pick what this screen shows. Resumes a stored display automatically. */
export function TvHome() {
  const t = useT();
  const navigate = useNavigate();
  useEffect(() => {
    for (const kind of ['cash', 'tournament'] as const) {
      const stored = loadDisplay(kind);
      if (stored) { navigate(`/tv/${kind}/${stored.token}`, { replace: true }); return; }
    }
  }, [navigate]);
  return (
    <TvShell className="tv-center">
      <div className="tv-message">
        <span className="eyebrow">{t('tv_title')}</span>
        <h1>{t('tv_choose_title')}</h1>
        <div className="tv-choices">
          <Link className="btn primary lg" to="/tv/cash" autoFocus>{t('tv_choose_cash')}</Link>
          <Link className="btn outline-gold lg" to="/tv/tournament">{t('tv_choose_tournament')}</Link>
        </div>
        <p className="faint">{t('tv_bookmark_hint')}</p>
      </div>
    </TvShell>
  );
}
