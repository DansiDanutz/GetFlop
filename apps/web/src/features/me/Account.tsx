import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { LanguageSwitch } from '../auth/Login';
import { ConsentToggle, DisplayNameField, PinChange } from './AccountBasics';
import { EmailSection, GoogleSection } from './AccountIdentity';
import { useIdentity } from './data';
import { DeleteAccount } from './DeleteAccount';
import { useInstall } from './install';
import { IosInstallSheet } from './MeOverlays';
import { replayWelcome } from './Welcome';
import './me.css';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card stack" aria-label={title}>
      <span className="eyebrow">{title}</span>
      {children}
    </section>
  );
}

/** #/account — name, sign-in & email, Google, PIN, consent, language, app, delete. */
export function Account() {
  const t = useT();
  const navigate = useNavigate();
  const { user } = useSession();
  const identity = useIdentity();
  const install = useInstall();
  const [iosOpen, setIosOpen] = useState(false);
  if (!user) return <Spinner />;

  return (
    <div className="screen">
      <TopBar subtitle={t('me_account_title')} />
      <div className="screen-body stack-lg">
        <h1>{t('me_account_title')}</h1>
        <Section title={t('me_section_profile')}>
          <DisplayNameField user={user} />
          <div className="row-between"><span className="muted">{t('username')}</span><strong>@{user.username}</strong></div>
        </Section>
        <Section title={t('me_section_signin')}>
          {identity.isLoading && <Spinner />}
          {identity.isError && <div className="banner danger">{t('err_generic')}</div>}
          {identity.data && <EmailSection identity={identity.data} />}
          {identity.data && <GoogleSection identity={identity.data} />}
        </Section>
        <Section title={t('me_section_pin')}><PinChange /></Section>
        <Section title={t('me_section_prefs')}>
          {identity.data && <ConsentToggle identity={identity.data} />}
          <div className="row-between"><span>{t('language')}</span><LanguageSwitch /></div>
        </Section>
        <Section title={t('me_section_app')}>
          <button type="button" className="btn ghost block" onClick={replayWelcome}>{t('me_replay_welcome')}</button>
          <button type="button" className="btn ghost block" onClick={() => navigate('/help')}>{t('me_help_title')}</button>
          {!install.installed && (install.canPrompt || install.ios) && (
            <button type="button" className="btn ghost block"
              onClick={() => (install.canPrompt ? void install.prompt() : setIosOpen(true))}>{t('me_install_cta_long')}</button>
          )}
        </Section>
        <Section title={t('me_section_danger')}><DeleteAccount /></Section>
      </div>
      <IosInstallSheet open={iosOpen} onClose={() => setIosOpen(false)} />
    </div>
  );
}
