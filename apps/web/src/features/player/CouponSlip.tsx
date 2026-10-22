import { useState, type ReactNode } from 'react';
import { ConfirmSheet, Sheet } from '../../components/Sheet';
import { Segmented } from '../../components/ui';
import { errorMessage, useT } from '../../i18n/i18n';
import { amount, multiplier } from '../../lib/format';
import { AmountInput } from './AmountInput';
import { acknowledgeLock, hasAcknowledgedLock } from './data';
import { marketKey } from './markets';
import {
  commitmentCents, estimatedMinutes, marketMax, perFlopCents, quickAmounts, slipIssue, topWinCents, type BlockReason, type SlipIssue,
} from './slip';
import type { TableView } from './types';
import type { Slip } from './useSlip';

const ROUND_PRESETS = [1, 3, 5, 10, 20] as const;
const STEP_CENTS = 100;

interface CouponSlipProps {
  open: boolean;
  onClose: () => void;
  table: TableView;
  slip: Slip;
  balanceCents: number;
  blockedBy: BlockReason | null;
  /** The LIVE tab content (my live coupons on this table). */
  live: ReactNode;
}

type SlipTab = 'coupon' | 'live';

/** The bottom-sheet coupon slip: picks, amount per flop, rounds, totals and Place. */
export function CouponSlip({ open, onClose, table, slip, balanceCents, blockedBy, live }: CouponSlipProps) {
  const t = useT();
  const [tab, setTab] = useState<SlipTab>('coupon');
  const [confirming, setConfirming] = useState(false);
  const { limits, unit } = table;
  const fmt = (c: number) => amount(c, unit);
  const total = commitmentCents(slip.picks, slip.rounds);
  const perFlop = perFlopCents(slip.picks);
  const issue = slipIssue({
    picks: slip.picks, rounds: slip.rounds, limits, unit, balanceCents, blockedBy, serverError: slip.serverError?.code ?? null,
  });
  const canPlace = slip.picks.length > 0 && !slip.busy && (issue === null || issue.kind === 'server');
  const sameAmount = slip.picks.every((p) => p.stakeCents === slip.picks[0]?.stakeCents);
  const math = t('player_slip_math', { amount: fmt(sameAmount ? slip.picks[0]?.stakeCents ?? 0 : perFlop), n: slip.rounds });
  const mathLine = sameAmount && slip.picks.length > 1
    ? t('player_slip_math_picks', { picks: slip.picks.length, math }) : math;

  const place = async () => {
    setConfirming(false);
    if (await slip.place()) onClose();
  };
  const onPlace = () => {
    if (hasAcknowledgedLock()) { void place(); return; }
    setConfirming(true);
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} title={t('player_slip_title')}>
        <Segmented value={tab} onChange={setTab} options={[
          { value: 'coupon', label: t('player_slip_tab_coupon') }, { value: 'live', label: t('player_slip_tab_live') },
        ]} />
        {tab === 'live' ? live : (
          <div className="stack">
            <p className="muted">{t('player_slip_explainer')}</p>
            {slip.picks.length === 0 && <p className="faint">{t('player_slip_empty')}</p>}
            <div className="list">
              {slip.picks.map((p) => (
                <div key={p.market} className="list-row">
                  <span className="grow">
                    <strong style={{ display: 'block' }}>{t(marketKey(p.market))}</strong>
                    <span className="faint">{multiplier(table.offered.find((m) => m.slug === p.market)?.multiplier ?? 0)} · {t('player_picker_max', { amount: fmt(marketMax(p.market, limits)) })}</span>
                  </span>
                  <AmountInput className="pl-amount-sm" label={t('player_slip_pick_amount', { name: t(marketKey(p.market)) })}
                    valueCents={p.stakeCents} onCommit={(c) => slip.setStake(p.market, c)} />
                  <button type="button" className="icon-btn" aria-label={t('player_slip_remove')} onClick={() => slip.toggle(p.market)}>✕</button>
                </div>
              ))}
            </div>
            {slip.picks.length > 0 && <button type="button" className="btn link" onClick={slip.clear}>{t('player_slip_clear')}</button>}

            <span className="eyebrow">{t('player_slip_amount_title')}</span>
            <div className="row">
              <button type="button" className="icon-btn" aria-label={t('player_slip_less')} onClick={() => slip.setShared(Math.max(limits.minCents, slip.sharedCents - STEP_CENTS))}>−</button>
              <AmountInput className="grow center" label={t('player_slip_amount_title')} valueCents={slip.sharedCents} onCommit={slip.setShared} />
              <button type="button" className="icon-btn" aria-label={t('player_slip_more')} onClick={() => slip.setShared(Math.min(limits.maxCents, slip.sharedCents + STEP_CENTS))}>+</button>
            </div>
            <div className="chips">
              {quickAmounts(limits).map((c) => (
                <button key={c} type="button" className={`chip ${slip.sharedCents === c ? 'on' : ''}`} onClick={() => slip.setShared(c)}>{fmt(c)}</button>
              ))}
              <button type="button" className={`chip ${slip.sharedCents === limits.maxCents ? 'on' : ''}`} onClick={() => slip.setShared(limits.maxCents)}>{t('player_slip_max')}</button>
            </div>
            <p className="faint">{t('player_slip_limits', { min: fmt(limits.minCents), max: fmt(limits.maxCents) })}</p>

            <span className="eyebrow">{t('player_slip_rounds_title')}</span>
            <div className="row">
              <button type="button" className="icon-btn" aria-label={t('player_slip_less')} onClick={() => slip.setRounds(slip.rounds - 1)}>−</button>
              <strong className="grow center pl-rounds" aria-live="polite">{slip.rounds}</strong>
              <button type="button" className="icon-btn" aria-label={t('player_slip_more')} onClick={() => slip.setRounds(slip.rounds + 1)}>+</button>
            </div>
            <div className="chips">
              {ROUND_PRESETS.filter((n) => n <= limits.maxRounds).map((n) => (
                <button key={n} type="button" className={`chip ${slip.rounds === n ? 'on' : ''}`} onClick={() => slip.setRounds(n)}>{n}</button>
              ))}
            </div>
            <p className="faint">{t('player_slip_rounds_max', { n: limits.maxRounds })}</p>

            <div className="card tight stack pl-totals">
              <div className="row-between">
                <span className="eyebrow">{t('player_slip_total')}</span>
                <strong className="pl-total">{fmt(total)}</strong>
              </div>
              <span className="muted">{mathLine}</span>
              <span className="muted">{t('player_slip_top_win', { amount: fmt(topWinCents(slip.picks, slip.rounds, table.offered)), m: estimatedMinutes(slip.rounds) })}</span>
              <span className="faint">{t('player_slip_balance', { amount: fmt(balanceCents) })}</span>
            </div>
            {issue && <IssueLine issue={issue} params={slip.serverError?.params ?? {}} unit={unit} />}
            <p className="faint">{t('player_slip_warning')}</p>
            <button type="button" className="btn danger lg block" disabled={!canPlace} onClick={onPlace}>
              {t('player_slip_place', { amount: fmt(total) })}
            </button>
          </div>
        )}
      </Sheet>
      <ConfirmSheet
        open={confirming} title={t('player_confirm_title')}
        body={t('player_confirm_body', { math: mathLine, total: fmt(total) })}
        confirmLabel={t('player_confirm_place')} cancelLabel={t('player_confirm_back')} busy={slip.busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => { acknowledgeLock(); void place(); }}
      />
    </>
  );
}

function IssueLine({ issue, params, unit }: { issue: SlipIssue; params: Record<string, string | number>; unit: string }) {
  const t = useT();
  const text = (() => {
    switch (issue.kind) {
      case 'server': return `${errorMessage(issue.code, params)} ${t('player_slip_nothing_charged')}`;
      case 'blocked': return t(`player_block_${issue.reason}`);
      case 'amount': return t('player_issue_amount', { min: amount(issue.min, unit), max: amount(issue.max, unit), name: t(marketKey(issue.market)) });
      case 'cap': return t('player_issue_cap', { max: amount(issue.max, unit) });
      case 'balance': return t('player_issue_balance');
    }
  })();
  return <div className="banner danger" role="alert">{text}</div>;
}
