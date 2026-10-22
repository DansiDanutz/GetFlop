import { useT } from '../../i18n/i18n';
import type { DockMode } from './api';

interface ActionDockProps {
  mode: DockMode;
  live: { players: number; picks: number };
  busy: boolean;
  /** "Closing picks…" while the no-more-picks request runs. */
  closing: boolean;
  coach: boolean;
  onNewHand: () => void;
  onNoMorePicks: () => void;
  onEnterFlop: () => void;
  onCancel: () => void;
}

/** Fixed bottom zone: the big buttons always sit in the same place. */
export function ActionDock({ mode, live, busy, closing, coach, onNewHand, onNoMorePicks, onEnterFlop, onCancel }: ActionDockProps) {
  const t = useT();
  const strip = live.picks > 0 ? t('dealer_live_strip', live) : t('dealer_no_picks');
  return (
    <div className="dock dealer-dock">
      {mode === 'auto' && <p className="hint">{t('dealer_auto_next')}</p>}
      {mode === 'new' && (
        <div className="coach-anchor">
          {coach && <span className="coach-bubble up" role="note">{t('dealer_coach_new_hand')}</span>}
          <button type="button" className="btn danger lg block dealer-pill" disabled={busy} onClick={onNewHand}>{t('dealer_new_hand')}</button>
        </div>
      )}
      {mode === 'open' && (
        <>
          <p className="hint" aria-live="polite">{strip}</p>
          <button type="button" className="btn danger lg block dealer-pill" disabled={busy} onClick={onNoMorePicks}>
            {closing ? t('dealer_closing') : t('dealer_no_more_picks')}
          </button>
          <button type="button" className="btn lg block dealer-cancel" disabled={busy} onClick={onCancel}>{t('dealer_cancel_hand')}</button>
        </>
      )}
      {mode === 'closed' && (
        <>
          <p className="hint">{strip}</p>
          <button type="button" className="btn danger lg block dealer-pill" disabled={busy} onClick={onEnterFlop}>{t('dealer_enter_flop')}</button>
          <button type="button" className="btn lg block dealer-cancel" disabled={busy} onClick={onCancel}>{t('dealer_cancel_hand')}</button>
        </>
      )}
    </div>
  );
}
