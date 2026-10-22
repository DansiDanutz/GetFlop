import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { amount } from '../../lib/format';
import { arenaApi, useArenaRefresh } from './api';
import { readReturn, type PaymentReturn as Return } from './logic';

/** Handles `#/arena?order=…&stars=success|cancel` after the payment page (and the DEV simulator). */
export function PaymentReturn() {
  const t = useT();
  const toast = useToast();
  const refresh = useArenaRefresh();
  const location = useLocation();
  const navigate = useNavigate();
  const [pending, setPending] = useState<Return | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ret = readReturn(location.search);
    if (!ret) return;
    navigate('/arena', { replace: true });
    if (ret.outcome === 'cancel') {
      arenaApi.cancelOrder(ret.orderId)
        .then(() => toast.show(t('arena_pay_cancelled'), 'info'))
        .catch((err: unknown) => toast.error(err));
      return;
    }
    if (ret.simulate) { setPending(ret); return; }
    api.get<{ status: string; starsCents: number }>(`/arena/orders/${ret.orderId}`)
      .then((o) => toast.show(o.status === 'paid' ? t('arena_pay_added', { stars: amount(o.starsCents, 'stars') }) : t('arena_pay_confirming'), 'success'))
      .catch((err: unknown) => toast.error(err))
      .finally(refresh);
  }, [location.search, navigate, refresh, t, toast]);

  async function settle(paid: boolean) {
    if (!pending) return;
    setBusy(true);
    try {
      if (paid) {
        const r = await arenaApi.simulatePaid(pending.orderId);
        toast.show(t('arena_pay_added', { stars: amount(r.starsCents, 'stars') }), 'success');
      } else {
        await arenaApi.cancelOrder(pending.orderId);
        toast.show(t('arena_pay_cancelled'), 'info');
      }
      refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <ConfirmSheet open={pending !== null} title={t('arena_pay_dev_title')} body={t('arena_pay_dev_body')}
      confirmLabel={t('arena_pay_dev_confirm')} cancelLabel={t('arena_pay_dev_cancel')} busy={busy}
      onConfirm={() => void settle(true)} onCancel={() => void settle(false)} />
  );
}
