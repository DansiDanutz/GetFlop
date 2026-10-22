import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CountdownRing } from '../../components/Countdown';
import { useToast } from '../../components/Toast';
import { Empty, Spinner } from '../../components/ui';
import { useT } from '../../i18n/i18n';
import { amount } from '../../lib/format';
import { arenaApi, arenaKeys, useArenaRefresh, useArenaSummary, type ArenaTable } from './api';
import { ArenaHeader } from './ArenaHeader';
import { clockEndsAt, fmtParams, refillLine } from './logic';
import { PaymentReturn } from './PaymentReturn';
import { RefillButton } from './RefillButton';
import { StarsShop } from './StarsShop';
import './arena.css';

/** #/arena: the Arena home — balance, free refill, the tables, the board and the badges. */
export function ArenaLobby() {
  const t = useT();
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useArenaRefresh();
  const summary = useArenaSummary();
  const tables = useQuery({ queryKey: arenaKeys.tables, queryFn: arenaApi.tables, refetchInterval: 15_000, enabled: Boolean(summary.data?.entered) });
  const [shopOpen, setShopOpen] = useState(false);
  const entering = useRef(false);

  // First visit: join and receive the welcome Stars.
  useEffect(() => {
    const s = summary.data;
    if (!s?.open || s.entered || entering.current) return;
    entering.current = true;
    arenaApi.enter()
      .then((r) => {
        if (r.kind === 'welcome') toast.show(t('arena_welcome_granted', { stars: amount(r.grantedCents, 'stars') }), 'success');
        refresh();
      })
      .catch((err: unknown) => toast.error(err));
  }, [summary.data, refresh, t, toast]);

  const s = summary.data;
  const line = s?.refill ? refillLine(s.refill, Date.now()) : null;
  return (
    <div className="screen arena">
      <ArenaHeader title={t('arena_title')} back="/clubs" balanceCents={s?.balanceCents} onStars={() => setShopOpen(true)} />
      <main className="screen-body">
        {summary.isLoading && <Spinner />}
        {summary.isError && <Empty icon="★" title={t('err_arena_unavailable')}><button type="button" className="btn ghost" onClick={() => void summary.refetch()}>{t('arena_refresh')}</button></Empty>}
        {s && !s.open && <Empty icon="★" title={t('arena_closed_title')}>{t('arena_closed_sub')}</Empty>}
        {s?.open && (
          <>
            <section className="card arena-hero">
              <span className="eyebrow">{t('arena_tagline')}</span>
              <strong className="arena-balance num">{amount(s.balanceCents, 'stars')}</strong>
              {line && <p className="muted">{t(line.key, fmtParams(line.params))}</p>}
              {s.refill?.ready && <RefillButton />}
            </section>
            {tables.isLoading && <Spinner />}
            {tables.data?.data.tables.length === 0 && <Empty icon="♠" title={t('arena_table_preparing')}>
              <button type="button" className="btn ghost" onClick={() => void tables.refetch()}>{t('arena_refresh')}</button></Empty>}
            {tables.data?.data.tables.map((table) => (
              <TableCard key={table.id} table={table} receivedAt={tables.data.receivedAt} onSit={() => navigate(`/arena/table?t=${table.id}`)} />
            ))}
            <div className="grid-3">
              <button type="button" className="btn ghost" onClick={() => navigate('/arena/board')}>{t('arena_board')}</button>
              <button type="button" className="btn ghost" onClick={() => navigate('/arena/medals')}>{t('arena_badges')}</button>
              <button type="button" className="btn ghost" onClick={() => setShopOpen(true)}>{t('arena_shop')}</button>
            </div>
            <p className="faint center">{t('arena_never_money')}</p>
          </>
        )}
      </main>
      <StarsShop open={shopOpen} onClose={() => setShopOpen(false)} />
      <PaymentReturn />
    </div>
  );
}

interface TableCardProps {
  table: ArenaTable;
  receivedAt: number;
  onSit: () => void;
}

function TableCard({ table, receivedAt, onSit }: TableCardProps) {
  const t = useT();
  const asleep = table.dealClock.phase === 'asleep';
  const endsAt = clockEndsAt(table.dealClock, receivedAt);
  return (
    <section className="card arena-table-card">
      <div className="row-between">
        <div className="stack" style={{ gap: 4 }}>
          <strong>{t('arena_table_name')}</strong>
          <span className={`badge ${asleep ? 'plain' : 'live'}`}>{asleep ? t('arena_state_asleep') : t('arena_state_dealing')}</span>
          <span className="muted">{asleep ? t('arena_wakes_when_you_sit') : t('arena_deals_every', { n: table.dealSeconds })}</span>
          {!asleep && table.dealClock.phase === 'open' && <span className="faint">{t('arena_next_flop_in')}</span>}
          <span className="faint">{t('arena_min_pick', { min: amount(table.limits.minCents, 'stars') })}</span>
        </div>
        {!asleep && table.dealClock.phase === 'open' && (
          <div className="arena-mini-ring"><CountdownRing endsAt={endsAt} totalSeconds={table.dealClock.windowMs / 1000} /></div>
        )}
      </div>
      <button type="button" className="btn primary block lg" onClick={onSit}>{t('arena_sit')}</button>
    </section>
  );
}
