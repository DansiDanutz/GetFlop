import { useState } from 'react';
import { Flop } from '../../components/PlayingCard';
import { TopBar } from '../../components/TopBar';
import { Empty, Segmented, Spinner, StatTile } from '../../components/ui';
import { amount, dateTime, multiplier, signed } from '../../lib/format';
import { useT } from '../../i18n/i18n';
import { CouponCard, DrawsSheet } from './CouponCard';
import { marketLabel, useHistory, type Coupon, type HistoryPick, type Movement } from './data';
import { BackTo, useMeLiveRefresh } from './MyGames';
import './me.css';

type Segment = 'coupons' | 'picks' | 'points';

/** #/me/history — coupons (riding and settled), settled picks and Points movements. */
export function History() {
  const t = useT();
  const history = useHistory();
  const [segment, setSegment] = useState<Segment>('coupons');
  const [openCoupon, setOpenCoupon] = useState<string | null>(null);
  useMeLiveRefresh();
  const data = history.data;

  return (
    <div className="screen">
      <TopBar subtitle={t('me_history_title')} />
      <div className="screen-body stack">
        <BackTo to="/me/games">{t('me_games_title')}</BackTo>
        <h1>{t('me_history_title')}</h1>
        {history.isLoading && <Spinner />}
        {history.isError && <div className="banner danger">{t('err_generic')}</div>}
        {data && (
          <>
            <div className="grid-2">
              <StatTile label={t('me_today_committed')} value={amount(data.summary.committedCents)} />
              <StatTile label={t('me_today_won')} value={amount(data.summary.wonCents)} />
              <StatTile label={t('me_today_net')} value={<span className={data.summary.netTodayCents >= 0 ? 'win' : 'loss'}>{signed(data.summary.netTodayCents)}</span>} />
              <StatTile label={t('me_riding_now')} value={amount(data.summary.ridingCents)} />
            </div>
            <Segmented value={segment} onChange={setSegment} options={[
              { value: 'coupons', label: t('me_seg_coupons') },
              { value: 'picks', label: t('me_seg_picks') },
              { value: 'points', label: t('me_seg_points') },
            ]} />
            {segment === 'coupons' && <CouponGroups coupons={data.coupons} onOpen={setOpenCoupon} />}
            {segment === 'picks' && <PickList picks={data.bets} />}
            {segment === 'points' && <MovementList moves={data.transactions} />}
          </>
        )}
      </div>
      <DrawsSheet couponId={openCoupon} onClose={() => setOpenCoupon(null)} />
    </div>
  );
}

function CouponGroups({ coupons, onOpen }: { coupons: Coupon[]; onOpen: (id: string) => void }) {
  const t = useT();
  const riding = coupons.filter((c) => c.status === 'live');
  const settled = coupons.filter((c) => c.status !== 'live');
  if (coupons.length === 0) return <Empty icon="♣" title={t('me_history_empty_coupons')} />;
  return (
    <div className="stack">
      {riding.length > 0 && <span className="eyebrow">{t('me_group_riding')}</span>}
      {riding.map((c) => <CouponCard key={c.id} coupon={c} onOpen={onOpen} />)}
      {settled.length > 0 && <span className="eyebrow">{t('me_group_settled')}</span>}
      {settled.map((c) => <CouponCard key={c.id} coupon={c} onOpen={onOpen} />)}
    </div>
  );
}

function PickList({ picks }: { picks: HistoryPick[] }) {
  const t = useT();
  if (picks.length === 0) return <Empty icon="♦" title={t('me_history_empty_picks')} />;
  return (
    <div className="card">
      {picks.map((p) => (
        <div key={p.id} className="me-move">
          <span className="stack" style={{ gap: 4 }}>
            <strong>{marketLabel(p.market)} {multiplier(p.multiplier)}</strong>
            <span className="faint">{p.tableName} · {t('me_draws_hand', { n: p.handNumber })} · {dateTime(p.settledAt)}</span>
          </span>
          {p.flop && <Flop cards={p.flop} size="sm" />}
          <span className={`amt ${p.status === 'won' ? 'win' : 'loss'}`}>
            {p.status === 'won' ? `+${amount(p.payoutCents)}` : `−${amount(p.stakeCents)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

function MovementList({ moves }: { moves: Movement[] }) {
  const t = useT();
  if (moves.length === 0) return <Empty icon="♥" title={t('me_history_empty_points')} />;
  return (
    <div className="card">
      {moves.map((m) => (
        <div key={m.id} className="me-move">
          <span className="stack" style={{ gap: 4 }}>
            <strong>{t(`me_kind_${m.label}`)}</strong>
            <span className="faint">{dateTime(m.createdAt)}{m.balanceAfterCents !== null ? ` · ${t('me_balance_after', { amount: amount(m.balanceAfterCents) })}` : ''}</span>
          </span>
          <span className={`amt ${m.amountCents > 0 ? 'win' : m.amountCents < 0 ? 'loss' : ''}`}>{signed(m.amountCents)}</span>
        </div>
      ))}
    </div>
  );
}
