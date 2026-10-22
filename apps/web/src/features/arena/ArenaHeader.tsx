import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';

interface ArenaHeaderProps {
  title: string;
  /** Where the back arrow goes. */
  back: string;
  balanceCents?: number;
  onStars?: () => void;
  right?: ReactNode;
}

/** Arena top bar: never shows the player's club, Points or display name. */
export function ArenaHeader({ title, back, balanceCents, onStars, right }: ArenaHeaderProps) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <button type="button" className="icon-btn" aria-label={t('arena_back')} onClick={() => navigate(back)}>‹</button>
      <strong className="grow truncate arena-title">{title}</strong>
      {right}
      {balanceCents !== undefined && (
        <button type="button" className="chip arena-stars-chip" aria-label={t('arena_open_shop')} onClick={onStars}>
          {amount(balanceCents, 'stars')}
        </button>
      )}
    </header>
  );
}
