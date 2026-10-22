import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Flop } from '../../components/PlayingCard';
import { useT } from '../../i18n/i18n';
import { amount, signed } from '../../lib/format';
import { marketKey } from './markets';
import type { MyWin } from './useTableLive';

/** How long the win screen stays up before the table comes back. */
const WIN_SCREEN_MS = 7_000;

/** Full-screen "you won": the flop, my winning markets with payouts, and the net for the hand. */
export function WinCelebration({ win, unit, onClose }: { win: MyWin | null; unit: string; onClose: () => void }) {
  const t = useT();
  useEffect(() => {
    if (!win) return;
    const id = setTimeout(onClose, WIN_SCREEN_MS);
    return () => clearTimeout(id);
  }, [win, onClose]);
  if (!win) return null;
  return createPortal(
    <div className="overlay pl-win" role="dialog" aria-modal="true" aria-label={t('player_win_title')} onClick={onClose}>
      <div className="pl-win-card stack-lg" onClick={(e) => e.stopPropagation()}>
        <span className="eyebrow center">{t('player_win_eyebrow')}</span>
        <h1 className="center pl-win-amount">{amount(win.payoutCents, unit)}</h1>
        <Flop cards={win.cards} size="md" />
        <div className="list">
          {win.picks.map((p) => (
            <div key={p.market} className="row-between list-row">
              <span className="market won pl-win-market">{t(marketKey(p.market))}</span>
              <strong className="win">+{amount(p.payoutCents, unit)}</strong>
            </div>
          ))}
        </div>
        <div className="row-between">
          <span className="muted">{t('player_win_net')}</span>
          <strong className={win.netCents >= 0 ? 'win' : 'loss'}>{signed(win.netCents, unit)}</strong>
        </div>
        <button type="button" className="btn primary lg block" onClick={onClose}>{t('player_win_continue')}</button>
      </div>
    </div>,
    document.body,
  );
}
