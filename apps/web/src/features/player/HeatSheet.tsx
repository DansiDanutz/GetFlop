import { Sheet } from '../../components/Sheet';
import { Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { useHeat } from './data';
import { heatHeadline, HEAT_MIN_FLOPS } from './markets';
import type { HeatBoard, HeatMarket } from './types';

const HELP_ITEMS = ['bar', 'band', 'numbers', 'predict', 'hands'] as const;
/** Bars are scaled so the tallest of rate / band top reaches this share of the track. */
const BAR_HEADROOM = 1.15;

const shortKey = (slug: string) => `player_heat_short_${slug.replace(/-/g, '_')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The Hot & cold sheet: bars against the expected band, hot/cold lists with bead strips, help. */
export function HeatSheet({ tableId, open, onClose }: { tableId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const q = useHeat(tableId, open);
  const board = q.data;
  return (
    <Sheet open={open} onClose={onClose} title={t('player_heat_title')}>
      {q.isLoading && <Spinner />}
      {q.isError && <p className="banner danger">{t('player_heat_error')}</p>}
      {board && <HeatContent board={board} />}
    </Sheet>
  );
}

function names(slugs: readonly string[], t: (k: string) => string): string {
  const labels = slugs.map((s) => t(shortKey(s)));
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} ${t('player_heat_and')} ${labels.at(-1)}`;
}

export function HeatContent({ board }: { board: HeatBoard }) {
  const t = useT();
  const headline = heatHeadline(board);
  const dim = board.flopsCounted < board.window;
  const byslug = new Map(board.markets.map((m) => [m.slug, m]));
  const sentence = (() => {
    if (headline.state === 'few') return t('player_heat_few', { n: board.flopsCounted, min: HEAT_MIN_FLOPS });
    if (headline.state === 'filling') return t('player_heat_filling', { n: board.flopsCounted, window: board.window });
    if (headline.state === 'calm') return t('player_heat_calm');
    return [
      headline.hot.length > 0 ? t('player_heat_showing', { names: names(headline.hot, t) }) : '',
      headline.cold.length > 0 ? t('player_heat_quiet', { names: names(headline.cold, t) }) : '',
    ].filter(Boolean).join(' ');
  })();

  return (
    <div className="stack">
      <p className="pl-heat-headline">{sentence}</p>
      <span className="faint">{t('player_heat_window', { n: board.flopsCounted, window: board.window })}</span>
      <div className={`pl-heat ${dim ? 'dim' : ''}`}>
        {board.markets.map((m) => <HeatBar key={m.slug} market={m} />)}
      </div>
      {headline.state === 'mixed' && (
        <div className="grid-2">
          <HeatList title={t('player_heat_hot')} slugs={headline.hot} byslug={byslug} kind="hot" />
          <HeatList title={t('player_heat_cold')} slugs={headline.cold} byslug={byslug} kind="cold" />
        </div>
      )}
      <p className="banner">{t('player_heat_not_prediction')}</p>
      <div className="stack">
        {HELP_ITEMS.map((k) => (
          <details key={k} className="card tight pl-help">
            <summary>{t(`player_heat_help_${k}_q`)}</summary>
            <p className="muted">{t(`player_heat_help_${k}_a`, { window: board.window })}</p>
          </details>
        ))}
      </div>
    </div>
  );
}

function HeatBar({ market: m }: { market: HeatMarket }) {
  const t = useT();
  const scale = Math.max(m.rate, m.band.high, m.expected) * BAR_HEADROOM || 1;
  const at = (x: number) => `${Math.min(100, (x / scale) * 100)}%`;
  return (
    <div className={`pl-heat-row ${m.state}`}>
      <span className="pl-heat-label">{t(shortKey(m.slug))}</span>
      <div className="pl-heat-track" role="img" aria-label={t('player_heat_bar_aria', { hits: m.hits, rate: pct(m.rate), expected: pct(m.expected) })}>
        <div className="pl-heat-band" style={{ left: at(m.band.low), width: `calc(${at(m.band.high)} - ${at(m.band.low)})` }} />
        <div className="pl-heat-fill" style={{ width: at(m.rate) }} />
        <div className="pl-heat-exp" style={{ left: at(m.expected) }} />
      </div>
      <span className="pl-heat-num num">{m.hits} <span className="faint">/ {pct(m.expected)}</span></span>
    </div>
  );
}

function HeatList({ title, slugs, byslug, kind }: {
  title: string; slugs: readonly string[]; byslug: Map<string, HeatMarket>; kind: 'hot' | 'cold';
}) {
  const t = useT();
  return (
    <div className="card tight stack">
      <span className={`eyebrow pl-${kind}`}>{title}</span>
      {slugs.length === 0 && <span className="faint">—</span>}
      {slugs.map((s) => {
        const m = byslug.get(s);
        if (!m) return null;
        return (
          <div key={s} className="stack" style={{ gap: 4 }}>
            <strong>{t(shortKey(s))} <span className="faint">{m.hits}</span></strong>
            <div className="pl-beads" aria-hidden>{m.hitSeq.map((hit, i) => <span key={i} className={hit ? 'on' : ''} />)}</div>
          </div>
        );
      })}
    </div>
  );
}
