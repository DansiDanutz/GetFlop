import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Sheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { api } from '../../lib/api';
import { AdminShell } from './AdminShell';
import { useAdmin, type BetType, type BetTypeUpdateResult } from './api';
import { edgeOf, multiplierOf, parseOdds, pct } from './logic';
import { Loadable, Pts } from './parts';

export function MarketsView() {
  const t = useT();
  const query = useAdmin<{ betTypes: BetType[] }>(['bet-types'], '/admin/bet-types');
  const [editing, setEditing] = useState<BetType | null>(null);
  return (
    <div className="stack">
      <h1>{t('admin_markets_title')}</h1>
      <p className="muted">{t('admin_markets_note')}</p>
      <Loadable query={query}>
        {(d) => (
          <div className="stack">
            {d.betTypes.map((b) => (
              <button key={b.slug} type="button" className={`card tight row-card clickable ${b.edge < 0 ? 'edge-neg' : ''}`} onClick={() => setEditing(b)}>
                <div className="row-between">
                  <strong>{b.name}</strong>
                  <span className="row">
                    {!b.isActive && <span className="badge plain">{t('admin_market_off')}</span>}
                    <strong>×{b.multiplier}</strong>
                  </span>
                </div>
                <span className={`meta ${b.edge < 0 ? 'neg' : ''}`}>{t('admin_edge_chance', { edge: pct(b.edge), chance: pct(b.probability, 2) })}</span>
                {b.liveCoupons > 0 && <span className="meta">{t('admin_live_coupons_n', { n: b.liveCoupons })}</span>}
              </button>
            ))}
          </div>
        )}
      </Loadable>
      {editing && <EditMarketSheet market={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function MarketsScreen() {
  return <AdminShell><MarketsView /></AdminShell>;
}

export function EditMarketSheet({ market, onClose }: { market: BetType; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const [odds, setOdds] = useState(String(market.payoutOdds));
  const [active, setActive] = useState(market.isActive);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const parsed = parseOdds(odds);
  const newEdge = parsed === null ? null : edgeOf(parsed, market.probability);
  const changed = parsed !== null && (parsed !== market.payoutOdds || active !== market.isActive);

  function review(e: FormEvent) {
    e.preventDefault();
    if (changed) setConfirming(true);
  }

  async function save() {
    if (parsed === null) return;
    setBusy(true);
    try {
      const res = await api.put<BetTypeUpdateResult>(`/admin/bet-types/${encodeURIComponent(market.slug)}`, { payout_odds: parsed, is_active: active });
      toast.show(t('admin_market_saved', { name: res.betType.name, m: res.betType.multiplier }), res.negativeEdge ? 'error' : 'success');
      await qc.invalidateQueries({ queryKey: ['admin'] });
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={market.name} modal={confirming}>
      {!confirming && (
        <form className="stack" onSubmit={review}>
          <label>{t('admin_pays')}<input value={odds} onChange={(e) => setOdds(e.target.value)} inputMode="decimal" aria-invalid={parsed === null} /></label>
          {parsed === null && <span className="field-error">{t('err_admin_payout_invalid')}</span>}
          <dl className="kv">
            <dt>{t('admin_multiplier')}</dt><dd>{parsed === null ? '—' : `×${multiplierOf(parsed)}`}</dd>
            <dt>{t('admin_chance')}</dt><dd>{pct(market.probability, 2)}</dd>
            <dt>{t('admin_fair_multiplier')}</dt><dd>×{market.fairMultiplier.toFixed(2)} ({market.fairOdds.toFixed(2)}:1)</dd>
            <dt>{t('admin_house_edge')}</dt><dd className={newEdge !== null && newEdge < 0 ? 'neg' : undefined}>{newEdge === null ? '—' : pct(newEdge)}</dd>
          </dl>
          {newEdge !== null && newEdge < 0 && <div className="banner danger">{t('admin_edge_negative')}</div>}
          <label className="checkbox row"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t('admin_on_board')}</label>
          <p className="muted">{t('admin_price_note')}</p>
          <button type="submit" className="btn primary" disabled={!changed}>{t('admin_review_change')}</button>
        </form>
      )}
      {confirming && parsed !== null && newEdge !== null && (
        <div className="stack">
          <div className={`card tight stack ${newEdge < 0 ? 'edge-neg' : ''}`}>
            <span>{t('admin_confirm_price', { from: `×${market.multiplier}`, to: `×${multiplierOf(parsed)}` })}</span>
            <span className={newEdge < 0 ? 'neg' : undefined}>{t('admin_confirm_edge', { from: pct(market.edge), to: pct(newEdge) })}</span>
            <span>{active ? t('admin_confirm_on_board') : t('admin_confirm_off_board')}</span>
            <span>{t('admin_confirm_live', { n: market.liveCoupons })} · <Pts cents={market.unresolvedCents} /></span>
            <strong>{t('admin_confirm_keep_price')}</strong>
          </div>
          <div className="grid-2">
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)} disabled={busy}>{t('back')}</button>
            <button type="button" className={`btn ${newEdge < 0 ? 'danger' : 'primary'}`} onClick={() => void save()} disabled={busy}>{t('confirm')}</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
