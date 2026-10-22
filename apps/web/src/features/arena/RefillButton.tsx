import { useState } from 'react';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { arenaApi, useArenaRefresh } from './api';

/** "Take it": claims the free refill (POST /arena/enter). */
export function RefillButton() {
  const t = useT();
  const toast = useToast();
  const refresh = useArenaRefresh();
  const [busy, setBusy] = useState(false);
  async function take() {
    setBusy(true);
    try {
      const r = await arenaApi.enter();
      if (r.kind === 'refill') toast.show(t('arena_refill_taken', { amount: amount(r.grantedCents, 'stars') }), 'success');
      refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }
  return <button type="button" className="btn go block" disabled={busy} onClick={() => void take()}>{t('arena_refill_take')}</button>;
}
