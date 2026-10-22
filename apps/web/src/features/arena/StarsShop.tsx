import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/ui';
import { getLanguage, useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { arenaApi, arenaKeys, useArenaSummary, type Pack } from './api';
import { capLines, fmtParams, isSafeCheckoutUrl, refillLine } from './logic';
import { RefillButton } from './RefillButton';

const euros = (cents: number): string =>
  (cents / 100).toLocaleString(getLanguage() === 'el' ? 'el-GR' : 'en-GB', { style: 'currency', currency: 'EUR' });

interface StarsShopProps {
  open: boolean;
  onClose: () => void;
}

/** Star packs with the spending caps, the consent box and the free refill. */
export function StarsShop({ open, onClose }: StarsShopProps) {
  const t = useT();
  const toast = useToast();
  const shop = useQuery({ queryKey: arenaKeys.packs, queryFn: arenaApi.packs, enabled: open });
  const summary = useArenaSummary();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function buy(pack: Pack) {
    if (!consent) return toast.show(t('arena_shop_tick_first'), 'error');
    setBusy(pack.id);
    try {
      const { url } = await arenaApi.checkout(pack.id, getLanguage());
      if (!isSafeCheckoutUrl(url)) throw new Error('unsafe checkout url');
      window.location.assign(url);
    } catch (err) {
      toast.error(err);
      void shop.refetch();
    } finally {
      setBusy(null);
    }
  }

  const s = shop.data;
  const refill = summary.data?.refill;
  const line = refill ? refillLine(refill, Date.now()) : null;
  return (
    <Sheet open={open} onClose={onClose} title={t('arena_shop_title')}>
      <div className="stack">
        <div className="row-between">
          <span className="muted">{t('arena_shop_balance')}</span>
          <strong className="num">{amount(summary.data?.balanceCents ?? 0, 'stars')}</strong>
        </div>
        {line && <p className="muted">{t(line.key, fmtParams(line.params))}</p>}
        {refill?.ready && <RefillButton />}
        {shop.isLoading && <Spinner />}
        {s && !s.open && <div className="banner">{t('arena_shop_closed')}</div>}
        {s?.open && !s.cardPayments && <div className="banner">{t('arena_shop_cards_soon')}</div>}
        {s?.open && s.devPayments && <div className="banner ok">{t('arena_shop_dev_mode')}</div>}
        {s?.open && (
          <>
            <div className="list">
              {s.packs.map((p) => (
                <div key={p.id} className="list-row">
                  <span className="grow">
                    <strong className="num">{amount(p.starsCents, 'stars')}</strong>
                    {p.bonusPct ? <span className="pill arena-bonus">{t('arena_shop_bonus', { pct: p.bonusPct })}</span> : null}
                    <span className="faint" style={{ display: 'block' }}>{t('arena_shop_price_vat', { price: euros(p.priceCents) })}</span>
                    {p.unavailableReason && <span className="field-error">{t(`arena_pack_${p.unavailableReason}`)}</span>}
                  </span>
                  <button type="button" className="btn primary" disabled={!p.available || !s.cardPayments || busy !== null}
                    onClick={() => void buy(p)}>{busy === p.id ? '…' : t('arena_shop_buy')}</button>
                </div>
              ))}
            </div>
            {capLines(s).map((l) => (
              <p key={l.key} className="faint">{t(l.key, { left: euros(Number(l.params?.left)), cap: euros(Number(l.params?.cap)) })}</p>
            ))}
            <label className="checkbox">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              {t('arena_shop_consent')}
            </label>
            <p className="faint">{t('arena_shop_never_money')}</p>
          </>
        )}
      </div>
    </Sheet>
  );
}

