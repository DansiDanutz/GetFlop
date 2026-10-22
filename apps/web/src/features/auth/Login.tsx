import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { getLanguage, setLanguage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { isStandalone } from '../me/install';
import { readInvite, readTableJoin } from '../me/storage';
import { afterSignInPath } from './afterSignIn';
import { AuthShell } from './AuthShell';
import type { GoogleSignInResult } from './google';
import { GoogleButton } from './GoogleButton';

export function Login() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!username.trim()) return setError(t('username_error'));
    if (!/^\d{4,8}$/.test(pin)) return setError(t('pin_error'));
    setBusy(true);
    setError('');
    try {
      const { user } = await api.post<{ user: User }>('/auth/login', { username: username.trim(), pin, pwa: isStandalone(), lang: getLanguage() });
      signedIn(user);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  function signedIn(user: User) {
    qc.setQueryData(['me'], user);
    navigate(afterSignInPath(user, (location.state as { from?: string } | null)?.from), { replace: true });
  }

  async function google(credential: string) {
    setBusy(true);
    try {
      const res = await api.post<GoogleSignInResult>('/auth/google', { credential, pwa: isStandalone(), lang: getLanguage() });
      if (res.needsRegistration) navigate('/register/google', { state: res });
      else signedIn(res.user);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const join = readTableJoin();
  const invite = readInvite();

  return (
    <AuthShell>
      {join && <div className="banner ok" role="status">{t('login_joining_table', { table: join.tableName, club: join.clubName })}</div>}
      {!join && invite && <div className="banner ok" role="status">{t('login_invited')}</div>}
      <form className="stack" onSubmit={submit} noValidate>
        <label>{t('username')}
          <input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t('username')} />
        </label>
        <label>{t('pin')}
          <div className="row">
            <input className="pin-input grow" inputMode="numeric" autoComplete="current-password" type="password" maxLength={8}
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            <button className="btn primary" style={{ minWidth: 140 }} disabled={busy} type="submit">{t('login_submit')}</button>
          </div>
        </label>
        {error && <div className="field-error" role="alert">{error}</div>}
        <Link className="btn outline-gold block" to="/register">{t('register_new_player')}</Link>
        <GoogleButton onCredential={(c) => void google(c)} text="signin_with" />
        <div className="row" style={{ justifyContent: 'center', gap: 20 }}>
          <Link to="/forgot-pin">{t('login_forgot_pin')}</Link>
          <Link to="/help">{t('login_need_help')}</Link>
        </div>
      </form>
    </AuthShell>
  );
}

export function LanguageSwitch() {
  const t = useT();
  const lang = getLanguage();
  return (
    <div className="segmented" style={{ width: 'auto' }} aria-label={t('language')}>
      <button type="button" className={lang === 'en' ? 'on' : ''} onClick={() => setLanguage('en')}>EN</button>
      <button type="button" className={lang === 'el' ? 'on' : ''} onClick={() => setLanguage('el')}>ΕΛ</button>
    </div>
  );
}
