import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { useT } from '../../i18n/i18n';
import { useSession } from '../../state/session';
import { AuthShell } from './AuthShell';

/** Blocks the app until the current player terms are accepted. */
export function TermsGate() {
  const t = useT();
  const toast = useToast();
  const { refresh } = useSession();
  const [adult, setAdult] = useState(false);
  const [accept, setAccept] = useState(false);
  async function submit() {
    try {
      await api.post('/auth/accept-terms', { adult, acceptTerms: accept });
      await refresh();
    } catch (err) { toast.error(err); }
  }
  return (
    <AuthShell title={t('terms_title')}>
      <div className="card stack">
        <label className="checkbox"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />{t('register_adult')}</label>
        <label className="checkbox"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} />{t('register_terms')}</label>
        <button className="btn primary block" disabled={!adult || !accept} onClick={() => void submit()}>{t('continue')}</button>
      </div>
    </AuthShell>
  );
}
