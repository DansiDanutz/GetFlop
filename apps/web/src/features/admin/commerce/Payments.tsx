import { useState } from 'react';
import { ConfirmSheet } from '../../../components/Sheet';
import { useT } from '../../../i18n/i18n';
import { api } from '../../../lib/api';
import { dateTime } from '../../../lib/format';
import { useAdmin } from '../api';
import { labelOr, Loadable, Section, useAdminAction } from '../parts';
import { COMMERCE_BASE, REFUND_GROUNDS, type Order, type Payments } from './types';

const eur = (cents: number | null) => (cents === null ? '—' : `€${(cents / 100).toFixed(2)}`);

export function PaymentsTab() {
  const t = useT();
  const query = useAdmin<Payments>(['commerce', 'payments'], `${COMMERCE_BASE}/payments`);
  const { busy, run } = useAdminAction();
  const [refunding, setRefunding] = useState<Order | null>(null);
  return (
    <Loadable query={query}>
      {(p) => (
        <div className="stack-lg">
          <Section title={t('admin_pay_config')}>
            <dl className="kv">
              <dt>{t('admin_pay_cards')}</dt><dd>{p.config.cardPayments.available ? t('admin_on') : t('admin_off')}{p.config.cardPayments.testMode ? ` (${t('admin_test_mode')})` : ''}</dd>
              <dt>{t('admin_pay_vat')}</dt><dd>{p.config.vat ? t('admin_on') : t('admin_off')}</dd>
              <dt>{t('admin_pay_receipts')}</dt><dd>{p.config.receiptsMode}</dd>
              <dt>{t('admin_pay_refund_window')}</dt><dd>{t('admin_days_n', { n: p.config.refundWindowDays })}</dd>
              <dt>{t('admin_pay_requests')}</dt><dd>{p.diamondRequests}</dd>
            </dl>
          </Section>
          <Section title={t('admin_pay_alerts', { n: p.unreadAlerts })}
            action={p.unreadAlerts > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => api.post(`${COMMERCE_BASE}/alerts/read`))}>{t('admin_mark_read')}</button>}>
            {p.alerts.length === 0 && <p className="muted">{t('admin_nothing_here')}</p>}
            {p.alerts.map((a) => (
              <div key={a.id} className={`list-row ${a.readAt ? '' : 'neg'}`}>
                <span className="grow"><strong>{labelOr(`admin_alert_${a.kind}`, a.kind)}</strong> <span className="mono">{JSON.stringify(a.data)}</span></span>
                <span className="faint">{dateTime(a.createdAt)}</span>
              </div>
            ))}
          </Section>
          <Section title={t('admin_pay_orders')}>
            {p.orders.length === 0 && <p className="muted">{t('admin_nothing_here')}</p>}
            {p.orders.map((o) => (
              <div key={o.id} className="card tight row-card">
                <div className="row-between"><strong>{t('admin_order_line', { d: o.diamonds, club: o.clubName })}</strong><span className="pill">{o.status}</span></div>
                <span className="meta">{dateTime(o.paidAt ?? o.createdAt)} · {o.buyer} · {o.country ?? '—'}{o.isTest ? ` · ${t('admin_test_mode')}` : ''}</span>
                <span className="meta">{t('admin_order_amounts', { net: eur(o.netCents), vat: eur(o.vatCents), total: eur(o.totalCents) })}</span>
                {o.failureReason && <span className="meta neg">{o.failureReason}</span>}
                <span className="meta">{t('admin_receipt_state', { state: o.receiptStatus ?? '—' })}</span>
                {o.refund && <span className="meta">{t('admin_refunded_line', { eur: eur(o.refund.amountCents), d: o.refund.diamondsTakenBack })}{o.refund.diamondsShort > 0 ? ` · ${t('admin_refund_short', { d: o.refund.diamondsShort })}` : ''}</span>}
                {o.status === 'paid' && !o.refund && (
                  <div className="grid-2">
                    <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => api.post(`${COMMERCE_BASE}/orders/${o.id}/receipt`), t('admin_saved'))}>{t('admin_retry_receipt')}</button>
                    <button type="button" className="btn danger" disabled={busy} onClick={() => setRefunding(o)}>{t('admin_refund')}</button>
                  </div>
                )}
              </div>
            ))}
          </Section>
          <RefundConfirm order={refunding} onClose={() => setRefunding(null)} />
        </div>
      )}
    </Loadable>
  );
}

function RefundConfirm({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const t = useT();
  const { busy, run } = useAdminAction();
  const [ground, setGround] = useState<string>(REFUND_GROUNDS[0]);
  const confirm = async () => {
    if (!order) return;
    if (await run(() => api.post(`${COMMERCE_BASE}/orders/${order.id}/refund`, { ground }), t('admin_refund_done'))) onClose();
  };
  return (
    <ConfirmSheet open={Boolean(order)} danger busy={busy} title={t('admin_refund_title')} confirmLabel={t('admin_refund')} cancelLabel={t('cancel')}
      onCancel={onClose} onConfirm={() => void confirm()}
      body={
        <div className="stack">
          <span>{t('admin_refund_body', { total: eur(order?.totalCents ?? null) })}</span>
          <select value={ground} onChange={(e) => setGround(e.target.value)} aria-label={t('admin_refund_ground')}>
            {REFUND_GROUNDS.map((g) => <option key={g} value={g}>{t(`admin_refund_ground_${g}`)}</option>)}
          </select>
        </div>
      } />
  );
}
