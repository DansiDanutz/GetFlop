import { Flop } from '../../components/PlayingCard';
import { Sheet } from '../../components/Sheet';
import { useT } from '../../i18n/i18n';
import { amount, signed } from '../../lib/format';
import type { HandResult } from './logic';
import { marketName } from './MarketPicker';

interface WinSheetProps {
  result: HandResult | null;
  onClose: () => void;
}

/** The win screen: the flop, the markets that came in, each payout and the net for the hand. */
export function WinSheet({ result, onClose }: WinSheetProps) {
  const t = useT();
  return (
    <Sheet open={result !== null && result.won.length > 0} onClose={onClose} title={t('arena_you_won')}>
      {result && (
        <div className="stack center">
          <Flop cards={result.flop} size="md" />
          <div className="list">
            {result.won.map((w) => (
              <div key={w.market} className="list-row">
                <span className="grow" style={{ textAlign: 'left' }}>{marketName(t, w.market)}</span>
                <strong className="win num">+{amount(w.payoutCents, 'stars')}</strong>
              </div>
            ))}
          </div>
          <p className={`num ${result.netCents >= 0 ? 'win' : 'loss'}`}>{t('arena_net_hand', { net: signed(result.netCents, 'stars') })}</p>
          <button type="button" className="btn primary block" onClick={onClose}>{t('arena_keep_playing')}</button>
        </div>
      )}
    </Sheet>
  );
}
