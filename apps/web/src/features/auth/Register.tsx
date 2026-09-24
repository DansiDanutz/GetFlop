import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { getLanguage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { AuthShell } from './AuthShell';

interface Form {
  username: string; displayName: string; pin: string; pin2: string; email: string;
  adult: boolean; acceptTerms: boolean; marketingEmail: boolean;
}

export function Register() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>({ username: '', displayName: '', pin: '', pin2: '', email: '', adult: false, acceptTerms: false, marketingEmail: false });
  const [registrationId, setRegistrationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  function clientCheck(): string {
    if (!form.username.trim()) return t('username_error');
    if (!form.adult || !form.acceptTerms) return t('err_auth_terms_required');
    if (!/^\d{4}$/.test(form.pin)) return t('pin_error');
    if (form.pin !== form.pin2) return t('register_pin_mismatch');
    if (!form.email.trim()) return t('err_auth_email_required');
    return '';
  }

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    const problem = clientCheck();
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const { pin2: _unused, ...body } = form;
      const res = await api.post<{ registrationId: string }>('/auth/register/code', { ...body, displayName: form.displayName || form.username, lang: getLanguage() });
      setRegistrationId(res.registrationId);
      toast.show(t('register_code_sent', { email: form.email }), 'success');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { user } = await api.post<{ user: User }>('/auth/register', { registrationId, code });
      qc.setQueryData(['me'], user);
      toast.show(t('register_welcome', { name: user.displayName }), 'success');
      navigate('/clubs', { replace: true });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (registrationId) {
    return (
      <AuthShell title={t('register_code_title')}>
        <form className="stack" onSubmit={confirm}>
          <p className="muted">{t('register_code_sub', { email: form.email })}</p>
          <label>{t('register_code')}
            <input className="pin-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
          <button className="btn primary block" disabled={busy || code.length !== 6}>{t('register_btn')}</button>
          <button type="button" className="btn ghost block" disabled={busy} onClick={() => void sendCode()}>{t('register_resend')}</button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t('register_title')}>
      <form className="stack" onSubmit={sendCode} noValidate>
        <label>{t('username')}<input autoCapitalize="none" value={form.username} onChange={(e) => set('username', e.target.value)} /></label>
        <label>{t('display_name')}<input value={form.displayName} maxLength={30} onChange={(e) => set('displayName', e.target.value)} /></label>
        <div className="grid-2">
          <label>{t('pin')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={form.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))} /></label>
          <label>{t('pin_confirm')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={form.pin2} onChange={(e) => set('pin2', e.target.value.replace(/\D/g, ''))} /></label>
        </div>
        <label>{t('email')}<input type="email" autoComplete="email" value={form.email} onChange={(e) => set('email', e.target.value)} /></label>
        <label className="checkbox"><input type="checkbox" checked={form.adult} onChange={(e) => set('adult', e.target.checked)} />{t('register_adult')}</label>
        <label className="checkbox"><input type="checkbox" checked={form.acceptTerms} onChange={(e) => set('acceptTerms', e.target.checked)} />{t('register_terms')}</label>
        <label className="checkbox"><input type="checkbox" checked={form.marketingEmail} onChange={(e) => set('marketingEmail', e.target.checked)} />{t('register_marketing')}</label>
        {error && <div className="field-error" role="alert">{error}</div>}
        <button className="btn primary block" disabled={busy}>{t('register_send_code')}</button>
        <Link className="center" to="/login">{t('register_have_account')}</Link>
      </form>
    </AuthShell>
  );
}
