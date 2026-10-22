import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { Empty, Segmented, Spinner, StatTile } from '../../components/ui';
import { amount } from '../../lib/format';
import { getSocket } from '../../lib/socket';
import { useT } from '../../i18n/i18n';
import { CouponCard, DrawsSheet } from './CouponCard';
import { tableHref, useMyGames, type Game } from './data';
import { PointsSheet } from './PointsSheet';
import './me.css';

/** Coupon and balance events that change what "My games" shows. */
export const GAME_EVENTS = ['coupon:round-settled', 'coupon:completed', 'coupon:voided', 'coupon:leg-cancelled', 'balance:updated'] as const;

/** Refreshes this feature's queries on live coupon and balance events. */
export function useMeLiveRefresh(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void qc.invalidateQueries({ queryKey: ['my'] }); };
    GAME_EVENTS.forEach((e) => socket.on(e, refresh));
    return () => { GAME_EVENTS.forEach((e) => socket.off(e, refresh)); };
  }, [qc]);
}

export function BackTo({ to, children }: { to: string; children: ReactNode }) {
  const navigate = useNavigate();
  return <button type="button" className="me-back" onClick={() => navigate(to)}>‹ {children}</button>;
}

/** #/me/games — live coupons across the club's tables, and finished ones. */
export function MyGames() {
  const t = useT();
  const navigate = useNavigate();
  const games = useMyGames();
  const [tab, setTab] = useState<'live' | 'finished'>('live');
  const [openCoupon, setOpenCoupon] = useState<string | null>(null);
  const [pointsOpen, setPointsOpen] = useState(false);
  useMeLiveRefresh();
  const data = games.data;
  const list = tab === 'live' ? data?.live ?? [] : data?.recent ?? [];

  return (
    <div className="screen">
      <TopBar subtitle={t('me_games_title')} />
      <div className="screen-body stack">
        <BackTo to="/player">{t('me_back_lobby')}</BackTo>
        <div className="row-between">
          <h1>{t('me_games_title')}</h1>
          <button type="button" className="btn ghost" onClick={() => navigate('/me/history')}>{t('me_history_title')}</button>
        </div>
        {games.isLoading && <Spinner />}
        {games.isError && <div className="banner danger">{t('err_generic')}</div>}
        {data && (
          <>
            <div className="grid-3">
              <StatTile label={t('me_committed')} value={amount(data.totals.committedCents)} />
              <StatTile label={t('me_won')} value={amount(data.totals.wonCents)} />
              <button type="button" className="tile" onClick={() => setPointsOpen(true)} style={{ textAlign: 'left' }}>
                <span className="label">{t('me_still_riding')}</span>
                <span className="value">{amount(data.totals.stillAtStakeCents)}</span>
              </button>
            </div>
            {data.games.length > 0 && (
              <div className="scroll-x row">
                {data.games.map((g) => <GameChip key={g.tableId} game={g} onOpen={() => navigate(tableHref(g.tableId))} />)}
              </div>
            )}
            <Segmented value={tab} onChange={setTab} options={[
              { value: 'live', label: t('me_tab_live', { n: data.live.length }) },
              { value: 'finished', label: t('me_tab_finished') },
            ]} />
            {list.length === 0 && (
              <Empty icon="♠" title={t(tab === 'live' ? 'me_games_empty_live' : 'me_games_empty_finished')}>
                <button type="button" className="btn primary" onClick={() => navigate('/player')}>{t('me_games_to_lobby')}</button>
              </Empty>
            )}
            <div className="stack">
              {list.map((c) => <CouponCard key={c.id} coupon={c} onOpen={setOpenCoupon} />)}
            </div>
          </>
        )}
      </div>
      <DrawsSheet couponId={openCoupon} onClose={() => setOpenCoupon(null)} />
      <PointsSheet open={pointsOpen} onClose={() => setPointsOpen(false)} />
    </div>
  );
}

function GameChip({ game, onOpen }: { game: Game; onOpen: () => void }) {
  const t = useT();
  return (
    <button type="button" className="card clickable tight" style={{ minWidth: 180, textAlign: 'left' }} onClick={onOpen}>
      <strong className="truncate" style={{ display: 'block' }}>{game.tableName}</strong>
      <span className="faint" style={{ display: 'block' }}>{t(`me_game_state_${game.state}`, { n: game.handNumber })}</span>
      <span className="muted">{t('me_game_riding', { amount: amount(game.stillAtStakeCents, game.unit), n: game.liveCoupons })}</span>
    </button>
  );
}
