import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { getLanguage, setLanguage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { AuthShell } from './AuthShell';

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
      const { user } = await api.post<{ user: User }>('/auth/login', { username: username.trim(), pin, lang: getLanguage() });
      qc.setQueryData(['me'], user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : user.role === 'admin' ? '/admin' : '/clubs', { replace: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
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
        <div className="row" style={{ justifyContent: 'center', gap: 20 }}>
          <Link to="/forgot-pin">{t('login_forgot_pin')}</Link>
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
