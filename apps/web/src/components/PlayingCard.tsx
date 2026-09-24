const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
const RED = new Set(['h', 'd']);

export type CardSize = 'sm' | 'md' | 'lg';

interface PlayingCardProps {
  /** Card code like "Qh" or "Tc". */
  code: string;
  size?: CardSize;
}

export function rankLabel(rank: string): string {
  return rank === 'T' ? '10' : rank;
}

export function PlayingCard({ code, size = 'lg' }: PlayingCardProps) {
  const rank = rankLabel(code.slice(0, -1).toUpperCase());
  const suit = code.slice(-1).toLowerCase();
  const glyph = SUIT_GLYPH[suit] ?? '?';
  const cls = ['pcard', size === 'lg' ? '' : size, RED.has(suit) ? 'red' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} role="img" aria-label={`${rank}${glyph}`}>
      <div className="corner"><span>{rank}</span><span>{glyph}</span></div>
      <div className="pip" aria-hidden>{glyph}</div>
      <div className="corner br" aria-hidden><span>{rank}</span><span>{glyph}</span></div>
    </div>
  );
}

export function CardBack({ size = 'lg' }: { size?: CardSize }) {
  return (
    <div className={`pcard back ${size === 'lg' ? '' : size}`} aria-label="Face-down card" role="img">
      <div className="felt"><div className="crest">♠</div></div>
    </div>
  );
}

/** Three cards, or three backs while the flop is unknown. */
export function Flop({ cards, size = 'lg' }: { cards: readonly string[] | null | undefined; size?: CardSize }) {
  const three = cards && cards.length === 3 ? cards : null;
  if (size === 'sm') {
    return (
      <div className="mini-flop">
        {three ? three.map((c) => <PlayingCard key={c} code={c} size="sm" />) : [0, 1, 2].map((i) => <CardBack key={i} size="sm" />)}
      </div>
    );
  }
  return (
    <div className="flop-row">
      {three ? three.map((c) => <PlayingCard key={c} code={c} size={size} />) : [0, 1, 2].map((i) => <CardBack key={i} size={size} />)}
    </div>
  );
}
