import { useEffect, useRef, useState } from 'react';
import { getLanguage, useT } from '../../i18n/i18n';
import { isInAppBrowser, loadGis, useGoogleConfig } from './google';

const BUTTON_WIDTH = 320;

interface GoogleButtonProps {
  /** Receives the Google ID token. */
  onCredential: (credential: string) => void;
  text?: 'signin_with' | 'continue_with';
}

/** Google's own button. Hidden when Google sign-in is off; explains in-app browsers instead. */
export function GoogleButton({ onCredential, text = 'continue_with' }: GoogleButtonProps) {
  const t = useT();
  const config = useGoogleConfig();
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  const [failed, setFailed] = useState(false);
  callback.current = onCredential;
  const clientId = config.data?.enabled ? config.data.clientId : null;
  const blocked = isInAppBrowser();

  useEffect(() => {
    if (!clientId || blocked || !ref.current) return;
    let alive = true;
    loadGis().then((gis) => {
      if (!alive || !ref.current) return;
      gis.accounts.id.initialize({ client_id: clientId, callback: (r) => callback.current(r.credential), ux_mode: 'popup' });
      gis.accounts.id.renderButton(ref.current, {
        theme: 'filled_black', size: 'large', shape: 'pill', text, width: BUTTON_WIDTH, locale: getLanguage(),
      });
    }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [clientId, blocked, text]);

  if (!clientId) return null;
  if (blocked) return <div className="banner" role="note">{t('google_in_app')}</div>;
  if (failed) return <div className="faint center">{t('google_unavailable')}</div>;
  return <div ref={ref} style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }} />;
}
