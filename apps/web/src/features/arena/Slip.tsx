import { useState } from 'react';
import { ConfirmSheet } from '../../components/Sheet';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { amount, parsePoints } from '../../lib/format';
import { arenaApi, type Market } from './api';
import { fmtParams, maxStakePerPick, slipProblem, slipTotals, STAR } from './logic';
import { marketName } from './MarketPicker';

const QUICK_STARS = [10, 25, 50, 100, 250];
const ROUND_PRESETS = [1, 3, 5, 10, 20];
const CONFIRMED_KEY = 'getflop_arena_confirmed';
/** Minutes per flop at this table's pace, for "≈ m min". */
const MINUTES_PER_FLOP = 0.5;

interface SlipProps {
  tableId: string;
  picks: Market[];
  minCents: number;
  maxRounds: number;
  balanceCents: number;
  onRemove: (slug: string) => void;
  onPlaced: () => void;
}

function wasConfirmed(): boolean {
  try { return localStorage.getItem(CONFIRMED_KEY) === '1'; } catch { return false; }
}

/** The coupon slip in Stars: one amount per pick per flop, how many flops, and the total. */
export function Slip({ tableId, picks, minCents, maxRounds, balanceCents, onRemove, onPlaced }: SlipProps) {
  const t = useT();
  const toast = useToast();
  const [stakeCents, setStake] = useState(minCents);
  const [typed, setTyped] = useState('');
  const [rounds, setRounds] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const totals = slipTotals(picks, stakeCents, rounds);
  const problem = slipProblem({ pickCount: picks.length, stakeCents, rounds, minCents, maxRounds, balanceCents });
  const max = maxStakePerPick(balanceCents, picks.length, rounds, minCents);
  const math = t('arena_slip_math', { per: amount(totals.perFlopCents, 'stars'), n: rounds });

  function typeAmount(text: string) {
    setTyped(text);
    const cents = parsePoints(text);
    if (cents !== null) setStake(cents);
  }

  async function place() {
    setConfirming(false);
    setBusy(true);
    setFailed(false);
    try {
      const r = await arenaApi.placeCoupon(tableId, picks.map((p) => p.slug), stakeCents, rounds);
      try { localStorage.setItem(CONFIRMED_KEY, '1'); } catch { /* storage unavailable */ }
      navigator.vibrate?.(30);
      toast.show(t('arena_coupon_placed', { total: amount(r.totalCommitmentCents, 'stars'), n: r.rounds, balance: amount(r.balanceCents, 'stars') }), 'success');
      setRounds(1);
      onPlaced();
    } catch (err) {
      setFailed(true);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack arena-slip">
      <div className="row-between">
        <strong>{t('arena_slip_title')}</strong>
        {picks.length > 0 && <span className="pill">{t('arena_slip_count', { n: picks.length })}</span>}
      </div>
      {picks.length === 0 && <p className="muted">{t('arena_slip_explainer')}</p>}
      <div className="chips">
        {picks.map((p) => (
          <button key={p.slug} type="button" className="chip on" aria-label={t('arena_slip_remove', { name: marketName(t, p.slug, p.name) })}
            onClick={() => onRemove(p.slug)}>{marketName(t, p.slug, p.name)} ✕</button>
        ))}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">{t('arena_slip_amount')}</span>
        <div className="row">
          <button type="button" className="icon-btn" aria-label={t('arena_less')} onClick={() => { setTyped(''); setStake(Math.max(minCents, stakeCents - 10 * STAR)); }}>−</button>
          <input className="grow center num" inputMode="decimal" value={typed || String(stakeCents / STAR)} onChange={(e) => typeAmount(e.target.value)} aria-label={t('arena_slip_amount')} />
          <button type="button" className="icon-btn" aria-label={t('arena_more')} onClick={() => { setTyped(''); setStake(stakeCents + 10 * STAR); }}>+</button>
        </div>
      </div>
      <div className="chips">
        {QUICK_STARS.map((n) => (
          <button key={n} type="button" className={`chip ${stakeCents === n * STAR ? 'on' : ''}`} onClick={() => { setTyped(''); setStake(n * STAR); }}>{n} ★</button>
        ))}
        <button type="button" className="chip" disabled={max === 0} onClick={() => { setTyped(''); setStake(max); }}>{t('arena_max')}</button>
      </div>
      <p className="faint">{t('arena_limits_line', { min: amount(minCents, 'stars') })}</p>
      <div className="stack" style={{ gap: 6 }}>
        <span className="eyebrow">{t('arena_slip_flops')}</span>
        <div className="chips">
          {ROUND_PRESETS.filter((n) => n <= maxRounds).map((n) => (
            <button key={n} type="button" className={`chip ${rounds === n ? 'on' : ''}`} onClick={() => setRounds(n)}>{n}</button>
          ))}
        </div>
        <span className="faint">{t('arena_max_rounds', { n: maxRounds })}</span>
      </div>
      <div className="row-between">
        <span className="eyebrow">{t('arena_total')}</span>
        <strong className="num">{amount(totals.commitmentCents, 'stars')}</strong>
      </div>
      <p className="faint">{math} · {t('arena_top_win', { win: amount(totals.topWinCents, 'stars'), m: Math.ceil(rounds * MINUTES_PER_FLOP) })}</p>
      {problem && picks.length > 0 && <p className="field-error">{t(problem.key, fmtParams(problem.params))}</p>}
      {failed && <p className="field-error">{t('arena_nothing_charged')}</p>}
      <button type="button" className="btn primary block lg" disabled={busy || problem !== null}
        onClick={() => (wasConfirmed() ? void place() : setConfirming(true))}>
        {t('arena_place', { total: amount(totals.commitmentCents, 'stars') })}
      </button>
      <p className="faint">{t('arena_slip_warning')}</p>
      <ConfirmSheet open={confirming} title={t('arena_confirm_title')}
        body={t('arena_confirm_body', { math, total: amount(totals.commitmentCents, 'stars') })}
        confirmLabel={t('arena_confirm_place')} cancelLabel={t('arena_confirm_back')}
        onConfirm={() => void place()} onCancel={() => setConfirming(false)} />
    </section>
  );
}
