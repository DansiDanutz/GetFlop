import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { TopBar } from '../../components/TopBar';
import { Empty, HandBadge, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { useSession } from '../../state/session';
import { CouponDrawsSheet } from './CouponDrawsSheet';
import { CouponSlip } from './CouponSlip';
import { takePlayAgain, useHandStats, usePlayerTable } from './data';
import { HeatSheet } from './HeatSheet';
import { LiveCoupons } from './LiveCoupons';
import { MarketPicker } from './MarketPicker';
import { blockReason, tablePhase } from './markets';
import { RecentHands } from './RecentHands';
import { PHASE_KEY, TableStage } from './TableStage';
import type { CouponSummary, TableView } from './types';
import { useSlip, type Slip } from './useSlip';
import { useTableLive } from './useTableLive';
import { WinCelebration } from './WinCelebration';
import './player.css';

/** #/player/table/:id (and /heat): the player's view of one table. */
export function TableScreen({ showHeat = false }: { showHeat?: boolean }) {
  const t = useT();
  const { id = '' } = useParams();
  const q = usePlayerTable(id);
  if (q.isLoading) return <div className="screen"><TopBar /><Spinner /></div>;
  if (!q.data) {
    return (
      <div className="screen"><TopBar />
        <div className="screen-body"><Empty icon="♠" title={t('player_table_missing')}><a href="#/player">{t('player_back_lobby')}</a></Empty></div>
      </div>
    );
  }
  return <TableBody key={id} table={q.data.table} balanceCents={q.data.balanceCents} canPlay={q.data.canPlay} showHeat={showHeat} />;
}

interface TableBodyProps { table: TableView; balanceCents: number; canPlay: boolean; showHeat: boolean }

function TableBody({ table, balanceCents, canPlay, showHeat }: TableBodyProps) {
  const t = useT();
  const navigate = useNavigate();
  const { user, context } = useSession();
  const stats = useHandStats(table.id).data;
  const live = useTableLive(table.id, user?.id, table.unit);
  const slip = useSlip(table);
  const [slipOpen, setSlipOpen] = useState(false);
  const [drawsId, setDrawsId] = useState<string | null>(null);

  const blockedBy = table.status === 'open'
    ? blockReason({ canPlay, dealerId: table.dealerId, userId: user?.id, playMode: context?.playMode }) : null;
  const phase = tablePhase(table, stats?.hand?.status === 'cancelled');
  const tableOpen = table.status === 'open';

  usePlayAgainQueue(slip, () => setSlipOpen(true));

  const playAgainFrom = (c: CouponSummary) => {
    setDrawsId(null);
    if (slip.loadPlayAgain(c.picks.filter((p) => p.status === 'active').map((p) => ({ market: p.market, stakeCents: p.stakeCents })), c.rounds)) {
      setSlipOpen(true);
    }
  };
  const menu = (
    <>
      <button type="button" className="btn ghost block" onClick={() => navigate(`/player/table/${table.id}/heat`)}>{t('player_menu_heat')}</button>
      <button type="button" className="btn ghost block" onClick={() => navigate('/player/rules')}>{t('player_menu_rules')}</button>
      <button type="button" className="btn ghost block" onClick={() => navigate('/player')}>{t('player_menu_lobby')}</button>
    </>
  );

  return (
    <div className="screen">
      <TopBar subtitle={table.name} status={<HandBadge status={table.currentHand?.status} label={t(PHASE_KEY[phase])} />}
        onHelp={() => navigate('/player/rules')} menu={menu} />
      <div className="screen-body with-actions">
        {live.connection !== 'connected' && <div className="banner danger">{t(`player_conn_${live.connection}`)}</div>}
        {!tableOpen && <div className="banner danger">{t('player_table_closed_notice')}</div>}
        {blockedBy && <div className="banner">{t(`player_block_${blockedBy}`)}</div>}
        <TableStage table={table} stats={stats} phase={phase} revealed={live.revealed} timerSeconds={live.timerSeconds} noMorePicks={live.noMorePicks} />
        <button type="button" className="btn ghost block" onClick={() => navigate(`/player/table/${table.id}/heat`)}>{t('player_heat_open')}</button>
        <RecentHands tableId={table.id} unit={table.unit} />
        <LiveCoupons tableId={table.id} onSeeAll={setDrawsId} onPlayAgain={playAgainFrom} />
        {tableOpen && table.offered.length > 0 && (
          <MarketPicker offered={table.offered} limits={table.limits} unit={table.unit} picks={slip.picks}
            settledSlugs={live.settledSlugs} disabled={Boolean(blockedBy)} onToggle={slip.toggle} />
        )}
      </div>
      {tableOpen && !blockedBy && (
        <div className="dock">
          <button type="button" className="btn danger lg block" onClick={() => setSlipOpen(true)}>
            {slip.picks.length === 0 ? t('player_rail_empty') : t('player_rail', { n: slip.picks.length })}
          </button>
          <span className="faint center">{t('player_rail_balance', { amount: amount(balanceCents, table.unit) })}</span>
        </div>
      )}
      <CouponSlip open={slipOpen} onClose={() => setSlipOpen(false)} table={table} slip={slip} balanceCents={balanceCents}
        blockedBy={blockedBy} live={<LiveCoupons tableId={table.id} onSeeAll={setDrawsId} onPlayAgain={playAgainFrom} liveOnly />} />
      <CouponDrawsSheet couponId={drawsId} onClose={() => setDrawsId(null)} onPlayAgain={tableOpen && !blockedBy ? playAgainFrom : undefined} />
      <HeatSheet tableId={table.id} open={showHeat} onClose={() => navigate(`/player/table/${table.id}`)} />
      <WinCelebration win={live.win} unit={table.unit} onClose={live.dismissWin} />
    </div>
  );
}

/** Loads a coupon queued by another screen ("Play again" from history) once the table is known. */
function usePlayAgainQueue(slip: Slip, onLoaded: () => void): void {
  useEffect(() => {
    const queued = takePlayAgain();
    if (queued && slip.loadPlayAgain(queued.picks, queued.rounds)) onLoaded();
    // Runs once per table mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
