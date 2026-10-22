import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { getLanguage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { GoogleButton } from '../auth/GoogleButton';
import { meKeys, type Identity } from './data';

const CODE_RE = /^\d{6}$/;

/** Email: add or change (PIN confirms), then verify with the 6-digit code. */
export function EmailSection({ identity }: { identity: Identity }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/email', { email: email.trim(), pin, lang: getLanguage() });
      setSentTo(email.trim());
      setPin('');
      toast.show(t('register_code_sent', { email: email.trim() }), 'success');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!CODE_RE.test(code)) return toast.show(t('err_auth_code_invalid'), 'error');
    setBusy(true);
    try {
      const { user } = await api.post<{ user: User }>('/auth/email/verify', { code });
      qc.setQueryData(['me'], user);
      await qc.invalidateQueries({ queryKey: meKeys.identity });
      toast.show(t('me_email_verified'), 'success');
      setSentTo(null); setEditing(false); setCode(''); setEmail('');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  if (sentTo) {
    return (
      <form className="stack" onSubmit={verify}>
        <p className="muted">{t('register_code_sub', { email: sentTo })}</p>
        <label>{t('register_code')}<input className="pin-input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
        <div className="grid-2">
          <button type="button" className="btn ghost" onClick={() => setSentTo(null)}>{t('back')}</button>
          <button className="btn primary" disabled={busy || code.length !== 6}>{t('confirm')}</button>
        </div>
      </form>
    );
  }

  return (
    <div className="stack">
      <div className="row-between">
        <span>
          <span style={{ display: 'block' }}>{identity.email ?? t('me_email_none')}</span>
          {identity.email && <span className={identity.emailVerified ? 'win' : 'faint'}>{t(identity.emailVerified ? 'me_email_verified_badge' : 'me_email_unverified')}</span>}
        </span>
        {!editing && <button type="button" className="btn ghost" onClick={() => setEditing(true)}>{t(identity.email ? 'me_email_change' : 'me_email_add')}</button>}
      </div>
      {!identity.email && !editing && <p className="faint">{t('me_email_nudge')}</p>}
      {editing && (
        <form className="stack" onSubmit={send}>
          <label>{t('email')}<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{t('me_pin_confirm_label')}<input className="pin-input" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>{t('cancel')}</button>
            <button className="btn primary" disabled={busy || !email.trim() || pin.length < 4}>{t('me_email_send_code')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Google link/unlink. Hidden entirely when Google sign-in is off. PIN first, then Google's button. */
export function GoogleSection({ identity }: { identity: Identity }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [linking, setLinking] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!identity.googleEnabled) return null;

  const update = (next: Identity) => qc.setQueryData(meKeys.identity, next);

  async function link(credential: string) {
    setBusy(true);
    try {
      update(await api.post<Identity>('/auth/google/link', { credential, pin }));
      toast.show(t('me_google_linked'), 'success');
      setLinking(false); setPin('');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  async function unlink() {
    setBusy(true);
    try {
      update(await api.del<Identity>('/auth/google/link'));
      toast.show(t('me_google_unlinked'), 'success');
      setConfirmUnlink(false);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <div className="row-between">
        <span>
          <span style={{ display: 'block' }}>{t('me_google_title')}</span>
          <span className="faint">{identity.google.linked ? identity.google.email ?? t('me_google_linked_short') : t('me_google_not_linked')}</span>
        </span>
        {identity.google.linked
          ? <button type="button" className="btn ghost" onClick={() => setConfirmUnlink(true)}>{t('me_google_unlink')}</button>
          : !linking && <button type="button" className="btn ghost" onClick={() => setLinking(true)}>{t('me_google_link')}</button>}
      </div>
      {linking && (
        <div className="stack">
          <label>{t('me_pin_confirm_label')}<input className="pin-input" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></label>
          {pin.length >= 4 && !busy
            ? <GoogleButton onCredential={(c) => void link(c)} />
            : <p className="faint">{t('me_google_pin_first')}</p>}
          <button type="button" className="btn ghost block" onClick={() => { setLinking(false); setPin(''); }}>{t('cancel')}</button>
        </div>
      )}
      <ConfirmSheet open={confirmUnlink} title={t('me_google_unlink_title')} body={t('me_google_unlink_body')}
        confirmLabel={t('me_google_unlink')} cancelLabel={t('cancel')} busy={busy}
        onConfirm={() => void unlink()} onCancel={() => setConfirmUnlink(false)} />
    </div>
  );
}
