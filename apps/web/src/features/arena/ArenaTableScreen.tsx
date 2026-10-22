import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../../components/Toast';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { getSocket, useSocketEvent, useTableRoom } from '../../lib/socket';
import { useSession } from '../../state/session';
import { arenaApi, arenaKeys, useArenaBar, useArenaRefresh, useArenaSummary } from './api';
import { ArenaHeader } from './ArenaHeader';
import { LiveCoupons } from './LiveCoupons';
import { handResultFor, type HandResult, type SettledPayload } from './logic';
import { MarketPicker } from './MarketPicker';
import { Slip } from './Slip';
import { Stage } from './Stage';
import { StarsShop } from './StarsShop';
import { WinSheet } from './WinSheet';
import './arena.css';

/** Presence heartbeat: keeps the table awake while this screen is open. */
const SIT_EVERY_MS = 20_000;
/** Refetch a little after a phase ends, once the server has moved on. */
const PHASE_SLACK_MS = 400;
const TABLE_EVENTS = ['hand:started', 'hand:no-more-bets', 'hand:betting-closed', 'hand:cancelled'] as const;

/** Refetches the table whenever its hand moves. */
function useTableEvents(tableId: string | null, onChange: () => void): void {
  useEffect(() => {
    if (!tableId) return;
    const s = getSocket();
    const handler = (p: { tableId?: string }) => { if (p?.tableId === tableId) onChange(); };
    TABLE_EVENTS.forEach((e) => s.on(e, handler));
    return () => { TABLE_EVENTS.forEach((e) => s.off(e, handler)); };
  }, [tableId, onChange]);
}

/** #/arena/table: the place-and-balance bar, the stage, the picker, the slip and live coupons. */
export function ArenaTableScreen() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useArenaRefresh();
  const { user } = useSession();
  const summary = useArenaSummary();
  const tableId = new URLSearchParams(useLocation().search).get('t') ?? summary.data?.tableId ?? null;
  const sat = useQuery({
    queryKey: arenaKeys.table(tableId ?? ''), queryFn: () => arenaApi.sit(tableId!), enabled: Boolean(tableId), refetchInterval: SIT_EVERY_MS,
  });
  const bar = useArenaBar();
  const coupons = useQuery({ queryKey: arenaKeys.coupons, queryFn: arenaApi.coupons });
  const [picks, setPicks] = useState<string[]>([]);
  const [shopOpen, setShopOpen] = useState(false);
  const [result, setResult] = useState<HandResult | null>(null);
  const [lastResult, setLastResult] = useState<HandResult | null>(null);
  useTableRoom(tableId);
  useTableEvents(tableId, refresh);

  const clock = sat.data?.data.table.dealClock;
  useEffect(() => {
    if (!clock || clock.phase === 'asleep') return;
    const id = setTimeout(refresh, clock.remainingMs + PHASE_SLACK_MS);
    return () => clearTimeout(id);
  }, [clock, refresh]);

  useSocketEvent<SettledPayload & { tableId: string }>('hand:settled', (p) => {
    if (p.tableId !== tableId || !user) return;
    const mine = handResultFor(p, user.id);
    setLastResult(mine);
    if (mine && mine.won.length > 0) setResult(mine);
    refresh();
  }, [tableId, user?.id]);
  useSocketEvent('balance:updated', () => refresh(), [refresh]);
  useSocketEvent<{ badges: string[] }>('arena:badges', ({ badges }) => {
    const first = badges[0];
    if (!first) return;
    toast.show(badges.length === 1 ? t('arena_badge_earned', { name: t(`arena_badge_${first}`) }) : t('arena_badges_earned', { n: badges.length }), 'success');
  }, []);

  const data = sat.data?.data;
  const table = data?.table;
  const chosen = table ? table.offered.filter((m) => picks.includes(m.slug)) : [];
  const toggle = (slug: string) => setPicks((list) => (list.includes(slug) ? list.filter((s) => s !== slug) : [...list, slug]));
  const rankChip = (
    <button type="button" className="chip" onClick={() => navigate('/arena/board')} aria-label={t('arena_open_board')}>
      {bar.data?.rank ? t('arena_rank', { n: bar.data.rank }) : t('arena_rank_none')}
    </button>
  );

  return (
    <div className="screen arena">
      <ArenaHeader title={t('arena_title')} back="/arena" balanceCents={data?.balanceCents ?? bar.data?.balanceCents}
        onStars={() => setShopOpen(true)} right={rankChip} />
      <main className="screen-body">
        {(sat.isLoading || summary.isLoading) && <Spinner />}
        {sat.isError && (
          <Empty icon="♠" title={t('arena_table_preparing')}>
            <button type="button" className="btn ghost" onClick={() => void sat.refetch()}>{t('arena_refresh')}</button>
          </Empty>
        )}
        {table && data && sat.data && (
          <>
            <Stage table={table} receivedAt={sat.data.receivedAt} lastResult={lastResult} />
            <MarketPicker markets={table.offered} selected={picks} onToggle={toggle} winning={table.lastHand?.matchingSlugs ?? []} />
            {!data.canPlay && <div className="banner">{t('arena_cannot_play')}</div>}
            <Slip tableId={table.id} picks={chosen} minCents={table.limits.minCents} maxRounds={table.limits.maxRounds}
              balanceCents={data.balanceCents} onRemove={toggle} onPlaced={() => { setPicks([]); refresh(); }} />
            <LiveCoupons coupons={coupons.data?.coupons ?? []} />
            <p className="faint center">{t('arena_no_requests', { min: amount(table.limits.minCents, 'stars') })}</p>
          </>
        )}
      </main>
      <StarsShop open={shopOpen} onClose={() => setShopOpen(false)} />
      <WinSheet result={result} onClose={() => setResult(null)} />
    </div>
  );
}
