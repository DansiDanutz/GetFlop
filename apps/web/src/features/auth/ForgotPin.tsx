import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { useT } from '../../i18n/i18n';
import { AuthShell } from './AuthShell';

export function ForgotPin() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/pin-reset/request', { username: username.trim() });
      setSent(true);
      toast.show(t('pin_reset_sent'), 'success');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{4}$/.test(pin)) return toast.show(t('pin_error'), 'error');
    if (pin !== pin2) return toast.show(t('register_pin_mismatch'), 'error');
    setBusy(true);
    try {
      await api.post('/auth/pin-reset/confirm', { username: username.trim(), code, newPin: pin });
      toast.show(t('pin_reset_done'), 'success');
      navigate('/login', { replace: true });
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <AuthShell title={t('pin_reset_title')}>
      {!sent ? (
        <form className="stack" onSubmit={request}>
          <p className="muted">{t('pin_reset_sub')}</p>
          <label>{t('username')}<input autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <button className="btn primary block" disabled={busy || !username.trim()}>{t('pin_reset_send')}</button>
        </form>
      ) : (
        <form className="stack" onSubmit={confirm}>
          <label>{t('pin_reset_code')}<input className="pin-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="grid-2">
            <label>{t('pin_reset_new')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
            <label>{t('pin_confirm')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} /></label>
          </div>
          <button className="btn primary block" disabled={busy}>{t('pin_reset_cta')}</button>
        </form>
      )}
      <Link className="center" to="/login">{t('back')}</Link>
    </AuthShell>
  );
}
