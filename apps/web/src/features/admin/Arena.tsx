import { useState } from 'react';
import { Segmented, StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { useAdmin } from './api';
import { pct } from './logic';
import { Loadable, Section } from './parts';

type Period = 'day' | 'week' | 'month' | 'all';
const PERIODS: readonly Period[] = ['day', 'week', 'month', 'all'];

/** Shape of GET /admin/platform/arena (served by the Arena module). */
interface ArenaReport {
  players: number;
  stars: {
    allTime: { grantedCents: number; boughtCents: number; inWalletsCents: number; houseHoldsCents: number };
    period: { grantedCents: number; refilledCents: number; boughtCents: number };
  };
  sales: { orders: number; buyers: number; chargedCents: number; vatCents: number; keptCents: number; packs: { id: string; orders: number; starsCents: number }[] };
  play: {
    hands: number; playedCents: number; paidCents: number; holdCents: number; holdPct: number | null; flopsAllTime: number;
    markets: { slug: string; picks: number; won: number; pricedMultiplier: number | null }[];
  };
  board: { players: number; flops: number; wins: number; hidden: number };
}

const stars = (c: number) => amount(c, 'stars');
const euros = (c: number) => `€${(c / 100).toFixed(2)}`;

export function ArenaView() {
  const t = useT();
  const [period, setPeriod] = useState<Period>('week');
  const query = useAdmin<ArenaReport>(['arena', period], `/admin/platform/arena?period=${period}`);
  return (
    <div className="stack">
      <h1>{t('admin_arena_title')}</h1>
      <p className="muted">{t('admin_arena_note')}</p>
      <Segmented value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(`admin_arena_period_${p}`) }))} />
      <Loadable query={query}>
        {(r) => (
          <div className="stack-lg">
            <Section title={t('admin_arena_stars_all')}>
              <div className="kpis">
                <StatTile label={t('admin_arena_granted')} value={stars(r.stars.allTime.grantedCents)} />
                <StatTile label={t('admin_arena_bought')} value={stars(r.stars.allTime.boughtCents)} />
                <StatTile label={t('admin_arena_in_wallets')} value={stars(r.stars.allTime.inWalletsCents)} />
                <StatTile label={t('admin_arena_house_holds')} value={stars(r.stars.allTime.houseHoldsCents)} />
              </div>
              <p className="muted">{t('admin_arena_period_line', { granted: stars(r.stars.period.grantedCents), refilled: stars(r.stars.period.refilledCents), bought: stars(r.stars.period.boughtCents) })}</p>
            </Section>
            <Section title={t('admin_arena_sales')}>
              <p className="muted">{t('admin_arena_sales_note')}</p>
              <p>{t('admin_arena_sales_line', { orders: r.sales.orders, buyers: r.sales.buyers, charged: euros(r.sales.chargedCents), vat: euros(r.sales.vatCents), kept: euros(r.sales.keptCents) })}</p>
              {r.sales.packs.map((p) => <div key={p.id} className="list-row"><span className="grow">{p.id}</span><span>{t('admin_arena_pack_line', { orders: p.orders, stars: stars(p.starsCents) })}</span></div>)}
            </Section>
            <Section title={t('admin_arena_play')}>
              <p>{t('admin_arena_play_line', { hands: r.play.hands, played: stars(r.play.playedCents), paid: stars(r.play.paidCents) })}</p>
              <p>{t('admin_arena_hold')}: {r.play.holdPct === null ? t('admin_arena_not_enough') : `${r.play.holdPct}%`}</p>
              <p className="muted">{t('admin_arena_flops_all', { n: r.play.flopsAllTime })}</p>
              {r.play.markets.map((m) => (
                <div key={m.slug} className="list-row">
                  <span className="grow">{m.slug}</span>
                  <span>{t('admin_arena_market_line', { picks: m.picks, won: m.won, priced: m.pricedMultiplier ? `×${m.pricedMultiplier}` : '—', rate: m.picks > 0 ? pct(m.won / m.picks) : '—' })}</span>
                </div>
              ))}
            </Section>
            <Section title={t('admin_arena_board')}>
              <p>{t('admin_arena_board_line', { flops: r.board.flops, wins: r.board.wins, hidden: r.board.hidden })}</p>
            </Section>
          </div>
        )}
      </Loadable>
    </div>
  );
}
