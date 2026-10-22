import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { Segmented, Spinner, StatTile } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount, dateTime, multiplier, signed } from '../../lib/format';
import { ownerApi, type CouponSummary, type Figures, type MarketFigure, type Movement } from './api';
import { CARD_PERIODS, type CardPeriod } from './logic';
import { marketLabel } from './useStaffClub';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

export function FigureTiles({ f, period, onPeriod }: { f: Figures; period: CardPeriod; onPeriod: (p: CardPeriod) => void }) {
  const t = useT();
  return (
    <section className="stack">
      <div className="row-between"><h3>{t('own_in_this_club')}</h3></div>
      <Segmented value={period} onChange={onPeriod} options={CARD_PERIODS.map((p) => ({ value: p, label: t(`own_period_${p}`) }))} />
      <div className="own-tiles">
        <StatTile label={t('own_fig_hands')} value={f.hands} />
        <StatTile label={t('own_fig_played')} value={amount(f.playedCents)} />
        <StatTile label={t('own_fig_won')} value={amount(f.wonCents)} />
        <StatTile label={t('own_fig_result')} value={<span className={f.resultCents >= 0 ? 'win' : 'loss'}>{signed(f.resultCents)}</span>} />
        <StatTile label={t('own_fig_sent_out')} value={amount(f.sentOutCents)} />
        <StatTile label={t('own_fig_claimed_back')} value={amount(f.claimedBackCents)} />
      </div>
      <p className="own-note">{t('own_fig_note')}</p>
    </section>
  );
}

export function WhereTheyPlay({ markets }: { markets: MarketFigure[] }) {
  const t = useT();
  if (markets.length === 0) return null;
  return (
    <section className="stack">
      <h3>{t('own_where_they_play')}</h3>
      <div className="card tight scroll-x">
        <table className="data">
          <thead><tr><th>{t('own_market')}</th><th className="num">{t('own_picks')}</th><th className="num">{t('own_fig_played')}</th><th className="num">{t('own_hit_rate')}</th></tr></thead>
          <tbody>
            {markets.map((m) => (
              <tr key={m.market}>
                <td>{marketLabel(m.market)}</td>
                <td className="num">{m.picks}</td>
                <td className="num">{amount(m.playedCents)}</td>
                <td className="num">{pct(m.hitRate)} <span className="faint">/ {pct(m.expectedRate)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="own-note">{t('own_hit_rate_note')}</p>
    </section>
  );
}

export function Movements({ rows }: { rows: Movement[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <section className="stack">
      <h3>{t('own_movements')}</h3>
      <div className="card tight">
        {rows.map((r) => (
          <div key={r.id} className="own-row" style={{ cursor: 'default' }}>
            <span className="grow">
              <strong style={{ display: 'block' }}>{t(`own_ledger_${r.kind}`)}{r.account === 'stock' && <span className="faint"> · {t('own_stock')}</span>}</strong>
              <span className="own-note">
                {dateTime(r.createdAt)}
                {r.actor && ` · ${r.actor.isSelf ? t('own_by_player') : t('own_by_name', { name: r.actor.name })}`}
                {r.note && ` · ${r.note}`}
              </span>
            </span>
            <span className={`own-amount ${r.amountCents >= 0 ? 'win' : 'loss'}`}>{signed(r.amountCents)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Coupons({ clubId, userId }: { clubId: string; userId: string }) {
  const t = useT();
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<CouponSummary | null>(null);
  const list = useQuery({
    queryKey: ['owner', 'coupons', clubId, userId, pages],
    queryFn: async () => {
      const all: CouponSummary[] = [];
      let more = false;
      for (let p = 0; p < pages; p++) {
        const page = await ownerApi.coupons(clubId, userId, all.length);
        all.push(...page.coupons);
        more = page.more;
        if (!more) break;
      }
      return { coupons: all, more };
    },
  });
  if (list.isLoading) return <Spinner />;
  const coupons = list.data?.coupons ?? [];
  if (coupons.length === 0) return null;
  return (
    <section className="stack">
      <h3>{t('own_coupons')}</h3>
      <div className="card tight">
        {coupons.map((c) => (
          <button key={c.id} type="button" className="own-row" onClick={() => setOpen(c)}>
            <span className="grow">
              <strong style={{ display: 'block' }}>{c.tableName}</strong>
              <span className="own-note">
                {c.picks.map((p) => `${marketLabel(p.market)} ${multiplier(p.multiplier)} · ${amount(p.stakeCents, c.unit)}`).join(' + ')}
              </span>
              <span className="own-note" style={{ display: 'block' }}>
                {t('own_flops_of', { d: c.roundsSettled, n: c.rounds })} · {dateTime(c.createdAt)}
                {c.status === 'live' && ` · ${t('own_still_in_play')}`}
                {c.status === 'voided' && ` · ${t('own_voided')}`}
              </span>
            </span>
            <span className="own-amount">{amount(c.wonCents, c.unit)}</span>
          </button>
        ))}
      </div>
      {list.data?.more && <button type="button" className="btn ghost block" onClick={() => setPages((p) => p + 1)}>{t('own_show_more')}</button>}
      {open && <CouponSheet clubId={clubId} userId={userId} coupon={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function CouponSheet({ clubId, userId, coupon, onClose }: { clubId: string; userId: string; coupon: CouponSummary; onClose: () => void }) {
  const t = useT();
  const detail = useQuery({ queryKey: ['owner', 'coupon', coupon.id], queryFn: () => ownerApi.coupon(clubId, userId, coupon.id) });
  return (
    <Sheet open onClose={onClose} title={coupon.tableName}>
      <div className="stack">
        {coupon.picks.map((p) => (
          <div key={p.market} className="own-line">
            <span>{marketLabel(p.market)} {multiplier(p.multiplier)}{p.status === 'cancelled' && <span className="loss"> · {t('own_leg_cancelled')}</span>}</span>
            <span>{t('own_per_flop', { amount: amount(p.stakeCents, coupon.unit) })}</span>
          </div>
        ))}
        {detail.isLoading && <Spinner />}
        {detail.data?.draws.map((d) => (
          <div key={d.handNumber} className="own-line">
            <span>{t('hand_label')}{d.handNumber}{d.flop && ` · ${d.flop.join(' ')}`}</span>
            <span>{d.picks.map((p) => t(`own_bet_${p.status}`)).join(' · ')}</span>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
