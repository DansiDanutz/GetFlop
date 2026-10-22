import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { api, ApiError, setApiClub } from '../../lib/api';
import { closeSocket } from '../../lib/socket';
import { errorMessage, useT } from '../../i18n/i18n';
import { clearInvite, clearTableJoin } from './storage';

/** Delete account: what happens, then the PIN. Blockers come back as translated errors. */
export function DeleteAccount() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/delete-account', { pin });
      closeSocket();
      setApiClub(null);
      clearInvite();
      clearTableJoin();
      qc.clear();
      qc.setQueryData(['me'], null);
      toast.show(t('me_delete_done'), 'success');
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err.code, err.params) : errorMessage('generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn danger block" onClick={() => setOpen(true)}>{t('me_delete_cta')}</button>
      <Sheet open={open} onClose={() => { setOpen(false); setPin(''); setError(''); }} title={t('me_delete_title')} modal>
        <form className="stack" onSubmit={submit}>
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>{t('me_delete_point_points')}</li>
            <li>{t('me_delete_point_clubs')}</li>
            <li>{t('me_delete_point_owner')}</li>
            <li>{t('me_delete_point_final')}</li>
          </ul>
          <label>{t('me_pin_confirm_label')}
            <input className="pin-input" type="password" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus />
          </label>
          {error && <div className="field-error" role="alert">{error}</div>}
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>{t('cancel')}</button>
            <button className="btn danger" disabled={busy || pin.length < 4}>{t('me_delete_confirm')}</button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
