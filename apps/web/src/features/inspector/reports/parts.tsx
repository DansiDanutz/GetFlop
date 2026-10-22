import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { hasKey, useT } from '../../../i18n/i18n';
import { api, qs } from '../../../lib/api';
import { amount, signed } from '../../../lib/format';
import { INSP, useCatalogue } from '../api';
import { bandPositions, collapseInside, pct, type MarketStat } from '../model/reports';
import type { ReportsIndex } from './types';

export const useReportsIndex = () => useQuery({
  queryKey: [INSP, 'reports-index'],
  queryFn: () => api.get<ReportsIndex>('/inspector/reports'),
  staleTime: 60_000,
});

/** Market display name: the shared translated name, else the catalogue name, else the slug. */
export function useMarketName(): (slug: string) => string {
  const t = useT();
  const catalogue = useCatalogue();
  return (slug) => {
    const key = `player_market_${slug.replace(/-/g, '_')}`;
    if (hasKey(key)) return t(key);
    return catalogue.data?.find((m) => m.slug === slug)?.name ?? slug;
  };
}

/** Downloads a server CSV (the active club is sent as ?clubId). */
export async function downloadServerCsv(path: string, params: Record<string, string | number | boolean | undefined>, clubId: string, filename: string): Promise<void> {
  const res = await fetch(`/api${path}${qs({ ...params, format: 'csv', clubId })}`, { credentials: 'include' });
  if (!res.ok) throw new Error('csv_failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function Strip({ items }: { items: { label: ReactNode; value: ReactNode; tone?: 'win' | 'loss' }[] }) {
  return (
    <div className="insp-strip">
      {items.map((it, i) => (
        <div key={i} className="tile">
          <span className="label">{it.label}</span>
          <span className={`value ${it.tone ?? ''}`}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

export const tone = (cents: number): 'win' | 'loss' | undefined => (cents > 0 ? 'win' : cents < 0 ? 'loss' : undefined);

export function Kv({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="list">
      {rows.map(([k, v], i) => (
        <div key={i} className="row-between insp-kv"><span className="muted">{k}</span><strong className="num">{v}</strong></div>
      ))}
    </div>
  );
}

/** Per-market hold vs theoretical, with the 95% band. Inside-band markets collapse into one line. */
export function MarketBands({ stats }: { stats: readonly MarketStat[] }) {
  const t = useT();
  const marketName = useMarketName();
  if (stats.length === 0) return <p className="muted">{t('insp_no_picks')}</p>;
  const { listed, insideCount } = collapseInside(stats);
  return (
    <div className="stack">
      {listed.map((s) => {
        const pos = bandPositions(s);
        return (
          <div key={s.slug} className="insp-band-row">
            <div className="row-between">
              <strong>{marketName(s.slug)}</strong>
              <span className={`pill insp-verdict ${s.verdict}`}>{t(`insp_verdict_${s.verdict}`)}</span>
            </div>
            <span className="faint insp-sub">
              {t('insp_band_line', { hits: s.hits, expected: s.expectedHits.toFixed(1), handle: amount(s.handleCents), hold: pct(s.holdPct), theo: pct(s.theoHoldPct) })}
            </span>
            {s.verdict !== 'low_volume' && (
              <div className="insp-band" aria-hidden>
                <span className="insp-band-range" style={{ left: `${pos.low}%`, width: `${pos.high - pos.low}%` }} />
                <span className="insp-band-theo" style={{ left: `${pos.theo}%` }} />
                {pos.actual !== null && <span className="insp-band-actual" style={{ left: `${pos.actual}%` }} />}
              </div>
            )}
          </div>
        );
      })}
      {insideCount > 0 && <p className="muted">{t('insp_markets_inside', { n: insideCount })}</p>}
    </div>
  );
}

export function LineTable({ rows, nameOf }: { rows: readonly (import('./types').Line & { key: string })[]; nameOf: (key: string) => ReactNode }) {
  const t = useT();
  if (rows.length === 0) return <p className="muted">{t('insp_no_picks')}</p>;
  return (
    <div className="scroll-x">
      <table className="data">
        <thead><tr><th>{t('insp_col_name')}</th><th className="num">{t('insp_col_hands')}</th><th className="num">{t('insp_col_played')}</th><th className="num">{t('insp_col_result')}</th><th className="num">{t('insp_col_hold')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{nameOf(r.key)}</td><td className="num">{r.hands}</td><td className="num">{amount(r.handleCents)}</td>
              <td className={`num ${tone(r.resultCents) ?? ''}`}>{signed(r.resultCents)}</td>
              <td className="num">{pct(r.holdPct)}{r.theoHoldPct !== null ? <span className="faint"> / {pct(r.theoHoldPct)}</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
