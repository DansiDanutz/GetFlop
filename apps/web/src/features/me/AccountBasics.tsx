import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useToast } from '../../components/Toast';
import { api, ApiError } from '../../lib/api';
import { errorMessage, useT } from '../../i18n/i18n';
import type { User } from '../../state/session';
import { meKeys, type Identity } from './data';

const AUTOSAVE_MS = 800;
const PIN_RE = /^\d{4}$/;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Display name with autosave ("Saving…" / "Saved"). */
export function DisplayNameField({ user }: { user: User }) {
  const t = useT();
  const qc = useQueryClient();
  const [value, setValue] = useState(user.displayName);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const saved = useRef(user.displayName);

  useEffect(() => {
    const name = value.trim();
    if (name === saved.current) return;
    const id = setTimeout(() => {
      if (!name) { setState('error'); setError(errorMessage('auth.display_name_required')); return; }
      setState('saving');
      api.put<{ user: User }>('/auth/display-name', { displayName: name })
        .then(({ user: fresh }) => {
          saved.current = fresh.displayName;
          qc.setQueryData(['me'], fresh);
          setState('saved');
          setError('');
        })
        .catch((err: unknown) => {
          setState('error');
          setError(err instanceof ApiError ? errorMessage(err.code, err.params) : errorMessage('generic'));
        });
    }, AUTOSAVE_MS);
    return () => clearTimeout(id);
  }, [value, qc]);

  return (
    <label>{t('me_account_display_name')}
      <input value={value} maxLength={30} onChange={(e) => { setValue(e.target.value); setState('idle'); }} />
      <span className={state === 'error' ? 'field-error' : 'me-saving'} role={state === 'error' ? 'alert' : 'status'}>
        {state === 'saving' ? t('me_saving') : state === 'saved' ? t('me_saved') : state === 'error' ? error : ''}
      </span>
    </label>
  );
}

/** Change PIN: current, new, repeat (4 digits). Other devices are signed out by the server. */
export function PinChange() {
  const t = useT();
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const digits = (v: string) => v.replace(/\D/g, '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!PIN_RE.test(next)) return toast.show(t('pin_error'), 'error');
    if (next !== again) return toast.show(t('register_pin_mismatch'), 'error');
    setBusy(true);
    try {
      await api.post('/auth/pin/change', { pin, newPin: next });
      toast.show(t('me_pin_changed'), 'success');
      setPin(''); setNext(''); setAgain('');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>{t('me_pin_current')}<input className="pin-input" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(digits(e.target.value))} /></label>
      <div className="grid-2">
        <label>{t('pin_reset_new')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={next} onChange={(e) => setNext(digits(e.target.value))} /></label>
        <label>{t('pin_confirm')}<input className="pin-input" type="password" inputMode="numeric" maxLength={4} value={again} onChange={(e) => setAgain(digits(e.target.value))} /></label>
      </div>
      <p className="faint">{t('me_pin_note')}</p>
      <button className="btn primary block" disabled={busy || pin.length < 4}>{t('me_pin_change')}</button>
    </form>
  );
}

/** Marketing email consent toggle (transactional mail is always sent). */
export function ConsentToggle({ identity }: { identity: Identity }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function toggle(on: boolean) {
    setBusy(true);
    try {
      await api.post('/auth/consent', { marketingEmail: on });
      qc.setQueryData<Identity>(meKeys.identity, (old) => (old ? { ...old, marketingEmail: on } : old));
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  }
  return (
    <label className="me-toggle">
      <span>
        <span style={{ display: 'block' }}>{t('me_consent_label')}</span>
        <span className="faint">{t('me_consent_note')}</span>
      </span>
      <input type="checkbox" role="switch" checked={identity.marketingEmail} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
    </label>
  );
}
