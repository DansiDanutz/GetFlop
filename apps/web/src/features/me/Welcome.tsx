import { useState, useSyncExternalStore } from 'react';
import { Sheet } from '../../components/Sheet';
import { useT } from '../../i18n/i18n';
import { KEYS, readFlag, setFlag } from './storage';
import { SUPPORT } from './support';
import './me.css';

/** The five first-run cards (art is a suit glyph; copy lives in the me dictionary). */
export const WELCOME_CARDS = [
  { art: '♠', key: 'predict' },
  { art: '♣', key: 'club' },
  { art: '♦', key: 'coupon' },
  { art: '★', key: 'points' },
  { art: '♥', key: 'help' },
] as const;

let replay = false;
const listeners = new Set<() => void>();

/** Shows the welcome cards again ("Getting to know GetFlop" on the account and help pages). */
export function replayWelcome(): void {
  replay = true;
  listeners.forEach((l) => l());
}

function useReplay(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => replay);
}

/** First-time welcome carousel, once per device; Skip / Next / Let's go. */
export function Welcome() {
  const t = useT();
  const replaying = useReplay();
  const [seen, setSeen] = useState(() => readFlag(KEYS.welcomeSeen));
  const [index, setIndex] = useState(0);
  const open = replaying || !seen;
  const card = WELCOME_CARDS[index]!;
  const last = index === WELCOME_CARDS.length - 1;

  const finish = () => {
    setFlag(KEYS.welcomeSeen, true);
    setSeen(true);
    setIndex(0);
    replay = false;
    listeners.forEach((l) => l());
  };

  return (
    <Sheet open={open} onClose={finish} modal>
      <div className="me-welcome" aria-live="polite">
        <div className="art" aria-hidden>{card.art}</div>
        <h2>{t(`me_welcome_${card.key}_title`)}</h2>
        <p className="muted">{t(`me_welcome_${card.key}_body`, { telegram: SUPPORT.telegramHandle, email: SUPPORT.email })}</p>
        <div className="me-dots" aria-label={t('me_welcome_step', { n: index + 1, total: WELCOME_CARDS.length })}>
          {WELCOME_CARDS.map((c, i) => <span key={c.key} className={i === index ? 'on' : ''} />)}
        </div>
        <div className="grid-2">
          <button type="button" className="btn ghost" onClick={finish}>{t('me_welcome_skip')}</button>
          {last
            ? <button type="button" className="btn primary" onClick={finish}>{t('me_welcome_go')}</button>
            : <button type="button" className="btn primary" onClick={() => setIndex(index + 1)}>{t('me_welcome_next')}</button>}
        </div>
      </div>
    </Sheet>
  );
}
