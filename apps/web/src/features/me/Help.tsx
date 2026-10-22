import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { AuthShell } from '../auth/AuthShell';
import { SUPPORT } from './support';
import { replayWelcome } from './Welcome';
import './me.css';

const FAQ = ['points', 'coupon', 'cancel', 'join', 'pin', 'device'] as const;

/** #/help — support contacts (Telegram, email) and short answers. Reachable signed out. */
export function Help() {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useSession();
  return (
    <AuthShell title={t('me_help_title')}>
      <section className="card stack" aria-label={t('me_help_contact')}>
        <span className="eyebrow">{t('me_help_contact')}</span>
        <p className="muted">{t('me_help_contact_sub')}</p>
        <a className="btn primary block" href={SUPPORT.telegramUrl} target="_blank" rel="noopener noreferrer">
          {t('me_help_telegram', { handle: SUPPORT.telegramHandle })}
        </a>
        <a className="btn ghost block" href={SUPPORT.emailUrl}>{t('me_help_email', { email: SUPPORT.email })}</a>
      </section>
      <section className="stack" aria-label={t('me_help_faq')}>
        <span className="eyebrow">{t('me_help_faq')}</span>
        {FAQ.map((key) => (
          <details key={key} className="card">
            <summary><strong>{t(`me_faq_${key}_q`)}</strong></summary>
            <p className="muted">{t(`me_faq_${key}_a`)}</p>
          </details>
        ))}
      </section>
      {user && <button type="button" className="btn ghost block" onClick={replayWelcome}>{t('me_replay_welcome')}</button>}
      <button type="button" className="btn link" onClick={() => navigate(user ? '/clubs' : '/login')}>{t('back')}</button>
    </AuthShell>
  );
}
