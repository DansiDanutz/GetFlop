import { Sheet } from '../../components/Sheet';
import { useT } from '../../i18n/i18n';
import { isLive, type DealerTable } from './api';

interface SeatConflictProps {
  /** The table the dealer is seated at now. */
  held: DealerTable | null;
  /** The table they tapped. */
  target: DealerTable | null;
  needsApproval: boolean;
  busy: boolean;
  onSwitch: () => void;
  onGoToHeld: () => void;
  onClose: () => void;
}

/** "You are dealing T (C). Leave it?" — or "Finish it there first" when a hand is live at the held table. */
export function SeatConflictSheet({ held, target, needsApproval, busy, onSwitch, onGoToHeld, onClose }: SeatConflictProps) {
  const t = useT();
  if (!held || !target) return null;
  const params = { table: held.name, club: held.clubName ?? '' };
  const live = isLive(held.currentHand);
  return (
    <Sheet open onClose={onClose} title={live ? t('dealer_conflict_live_title', params) : t('dealer_conflict_title', params)}>
      {live && <p className="muted">{t('dealer_conflict_live_body')}</p>}
      <div className="grid-2">
        <button type="button" className="btn ghost" onClick={onClose}>{t('cancel')}</button>
        {live
          ? <button type="button" className="btn primary" onClick={onGoToHeld}>{t('dealer_conflict_go', params)}</button>
          : (
            <button type="button" className="btn danger" disabled={busy} onClick={onSwitch}>
              {needsApproval ? t('dealer_conflict_ask') : t('dealer_conflict_sit')}
            </button>
          )}
      </div>
    </Sheet>
  );
}
