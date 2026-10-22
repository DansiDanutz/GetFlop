import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { getLanguage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { afterSignInPath } from './afterSignIn';
import { AuthShell } from './AuthShell';

export interface GoogleFinishState {
  registrationToken: string;
  email: string;
  suggestedUsername: string;
  emailTaken: boolean;
}

/** #/register/google — finish an account for a new Google identity (username, name, PIN, terms). */
export function GoogleFinish() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const state = useLocation().state as GoogleFinishState | null;
  const [username, setUsername] = useState(state?.suggestedUsername ?? '');
  const [displayName, setDisplayName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [adult, setAdult] = useState(false);
  const [terms, setTerms] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!state?.registrationToken) return <Navigate to="/login" replace />;

  function problem(): string {
    if (!username.trim()) return t('username_error');
    if (!/^\d{4}$/.test(pin)) return t('pin_error');
    if (pin !== pin2) return t('register_pin_mismatch');
    if (!adult || !terms) return t('err_auth_terms_required');
    return '';
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = problem();
    setError(p);
    if (p || !state) return;
    setBusy(true);
    try {
      const { user } = await api.post<{ user: User }>('/auth/google/register', {
        registrationToken: state.registrationToken, username: username.trim(), displayName: displayName.trim() || username.trim(),
        pin, adult, acceptTerms: terms, marketingEmail: marketing, lang: getLanguage(),
      });
      qc.setQueryData(['me'], user);
      toast.show(t('register_welcome', { name: user.displayName }), 'success');
      navigate(afterSignInPath(user), { replace: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t('google_finish_title')}>
      <form className="stack" onSubmit={submit} noValidate>
        <p className="muted">{t('google_finish_sub', { email: state.email })}</p>
        {state.emailTaken && <div className="banner danger" role="alert">{t('google_email_taken')}</div>}
        <label>{t('username')}<input autoCapitalize="none" value={username} maxLength={20} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{t('display_name')}<input value={displayName} maxLength={30} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <div className="grid-2">
          <label>{t('pin')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          <label>{t('pin_confirm')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />{t('register_adult')}</label>
        <label className="checkbox"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />{t('register_terms')}</label>
        <label className="checkbox"><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} />{t('register_marketing')}</label>
        {error && <div className="field-error" role="alert">{error}</div>}
        <button className="btn primary block" disabled={busy || state.emailTaken}>{t('register_btn')}</button>
        <Link className="center" to="/login">{t('back')}</Link>
      </form>
    </AuthShell>
  );
}
