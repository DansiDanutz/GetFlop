import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { useT } from '../../i18n/i18n';
import { signed, amount } from '../../lib/format';
import { onSocketStatus, useSocketEvent, useTableRoom } from '../../lib/socket';
import { fetchLatestSettled, playerKeys } from './data';
import type { HandSettledEvent } from './types';

interface TableEvent { tableId?: string; handId?: string }
interface FlopEvent extends TableEvent { card1: string; card2: string; card3: string }
interface StartedEvent extends TableEvent { bettingTimerSeconds?: number | null }
interface CouponCompleted { couponId: string; wonCents: number; committedCents: number; unit?: string }
interface CouponVoided { couponId: string; tableId?: string; refundCents: number; roundsUnresolved: number; unit?: string }

export interface MyWin {
  readonly handId: string;
  readonly cards: readonly string[];
  readonly picks: ReadonlyArray<{ market: string; stakeCents: number; payoutCents: number }>;
  readonly payoutCents: number;
  /** Payout minus everything I had on this hand. */
  readonly netCents: number;
}

export interface LiveState {
  /** Flop shown with the reveal animation (cleared when the next hand starts). */
  readonly revealed: { handId: string; cards: readonly string[] } | null;
  /** Markets that won on the last settled hand (highlighted in the picker). */
  readonly settledSlugs: readonly string[];
  readonly noMorePicks: boolean;
  readonly timerSeconds: number | null;
  readonly win: MyWin | null;
  readonly connection: 'connected' | 'reconnecting' | 'disconnected';
  dismissWin(): void;
}

const NO_MORE_PICKS_MS = 2_500;
/** Coming back after this long hidden triggers a catch-up request (spec 06 §4.6). */
export const CATCH_UP_AFTER_MS = 10 * 60_000;

/** Builds my result for a settled hand, or null when none of my picks won. */
export function myWinFrom(event: HandSettledEvent, userId: string | undefined): MyWin | null {
  if (!userId) return null;
  const won = event.winners.filter((b) => b.userId === userId);
  if (won.length === 0) return null;
  const lost = event.losers.filter((b) => b.userId === userId);
  const payoutCents = won.reduce((s, b) => s + b.payoutCents, 0);
  const stakes = [...won, ...lost].reduce((s, b) => s + b.amountCents, 0);
  return {
    handId: event.handId,
    cards: [event.card1, event.card2, event.card3],
    picks: won.map((b) => ({ market: b.betTypeSlug, stakeCents: b.amountCents, payoutCents: b.payoutCents })),
    payoutCents,
    netCents: payoutCents - stakes,
  };
}

/**
 * Joins the table room and keeps every player query fresh from socket events.
 * Returns transient stage state (reveal, highlights, overlay, win).
 */
export function useTableLive(tableId: string, userId: string | undefined, unit: string): LiveState {
  const qc = useQueryClient();
  const toast = useToast();
  const t = useT();
  const [revealed, setRevealed] = useState<LiveState['revealed']>(null);
  const [settledSlugs, setSettledSlugs] = useState<readonly string[]>([]);
  const [noMorePicks, setNoMorePicks] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState<number | null>(null);
  const [win, setWin] = useState<MyWin | null>(null);
  const [connection, setConnection] = useState<LiveState['connection']>('connected');
  const seenWins = useRef(new Set<string>());

  useTableRoom(tableId);
  useEffect(() => onSocketStatus(setConnection), []);

  const mine = (e: TableEvent | undefined) => !e?.tableId || e.tableId === tableId;
  const refreshTable = () => {
    void qc.invalidateQueries({ queryKey: playerKeys.table(tableId) });
    void qc.invalidateQueries({ queryKey: playerKeys.stats(tableId) });
  };
  const refreshHands = () => void qc.invalidateQueries({ queryKey: playerKeys.hands(tableId) });
  const refreshCoupons = () => {
    void qc.invalidateQueries({ queryKey: playerKeys.couponsAll });
    void qc.invalidateQueries({ queryKey: ['player', 'draws'] });
  };
  const showWin = (next: MyWin) => {
    if (seenWins.current.has(next.handId)) return;
    seenWins.current.add(next.handId);
    setWin(next);
  };

  useSocketEvent<StartedEvent>('hand:started', (e) => {
    if (!mine(e)) return;
    setRevealed(null);
    setSettledSlugs([]);
    setTimerSeconds(e.bettingTimerSeconds ?? null);
    refreshTable();
    refreshCoupons();
  }, [tableId]);

  useSocketEvent<TableEvent>('hand:no-more-bets', (e) => {
    if (!mine(e)) return;
    setNoMorePicks(true);
    setTimeout(() => setNoMorePicks(false), NO_MORE_PICKS_MS);
  }, [tableId]);

  useSocketEvent<TableEvent>('hand:betting-closed', (e) => { if (mine(e)) refreshTable(); }, [tableId]);

  useSocketEvent<FlopEvent>('hand:flop-revealed', (e) => {
    if (!mine(e) || !e.handId) return;
    setRevealed({ handId: e.handId, cards: [e.card1, e.card2, e.card3] });
  }, [tableId]);

  useSocketEvent<HandSettledEvent>('hand:settled', (e) => {
    if (!mine(e)) return;
    setSettledSlugs(e.matchingSlugs);
    const result = myWinFrom(e, userId);
    if (result) showWin(result);
    refreshTable();
    refreshHands();
    refreshCoupons();
    void qc.invalidateQueries({ queryKey: playerKeys.heat(tableId) });
  }, [tableId, userId]);

  useSocketEvent<TableEvent>('hand:cancelled', (e) => {
    if (!mine(e)) return;
    setRevealed(null);
    toast.show(t('player_toast_hand_cancelled'));
    refreshTable();
    refreshHands();
    refreshCoupons();
  }, [tableId]);

  useSocketEvent<TableEvent>('coupon:placed', (e) => { if (mine(e)) refreshTable(); }, [tableId]);
  useSocketEvent('coupon:round-settled', refreshCoupons, [tableId]);

  useSocketEvent<CouponCompleted>('coupon:completed', (e) => {
    refreshCoupons();
    toast.show(t('player_toast_coupon_finished', { net: signed(e.wonCents - e.committedCents, e.unit ?? unit) }));
  }, [unit]);

  useSocketEvent<CouponVoided>('coupon:voided', (e) => {
    refreshCoupons();
    toast.show(t('player_toast_coupon_voided', { amount: amount(e.refundCents, e.unit ?? unit), n: e.roundsUnresolved }));
  }, [unit]);

  useSocketEvent<TableEvent>('table:updated', (e) => {
    if (!mine(e)) return;
    refreshTable();
    void qc.invalidateQueries({ queryKey: playerKeys.tables });
  }, [tableId]);

  useSocketEvent<TableEvent>('table:closed', (e) => {
    if (!mine(e)) return;
    toast.show(t('player_toast_table_closed'));
    refreshTable();
    refreshCoupons();
    void qc.invalidateQueries({ queryKey: playerKeys.tables });
  }, [tableId]);

  useSocketEvent('balance:updated', () => {
    void qc.invalidateQueries({ queryKey: playerKeys.table(tableId) });
    void qc.invalidateQueries({ queryKey: playerKeys.balance });
  }, [tableId]);

  useCatchUp(tableId, userId, showWin);
  const dismissWin = useCallback(() => setWin(null), []);

  return { revealed, settledSlugs, noMorePicks, timerSeconds, win, connection, dismissWin };
}

/** After a long absence, asks the server for the latest settled hand and shows a missed win. */
function useCatchUp(tableId: string, userId: string | undefined, onWin: (w: MyWin) => void): void {
  const hiddenAt = useRef<number | null>(null);
  const onWinRef = useRef(onWin);
  onWinRef.current = onWin;
  const qc = useQueryClient();
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt.current = Date.now(); return; }
      const since = hiddenAt.current;
      hiddenAt.current = null;
      if (since === null || Date.now() - since < CATCH_UP_AFTER_MS || !userId) return;
      void qc.invalidateQueries({ queryKey: playerKeys.all });
      fetchLatestSettled([tableId]).then(({ tables }) => {
        const entry = tables[tableId];
        const won = entry?.mine.filter((b) => b.status === 'won') ?? [];
        if (!entry || won.length === 0) return;
        const stakes = entry.mine.reduce((s, b) => s + b.stakeCents, 0);
        onWinRef.current({
          handId: entry.handId, cards: entry.cards, payoutCents: entry.wonCents, netCents: entry.wonCents - stakes,
          picks: won.map((b) => ({ market: b.market, stakeCents: b.stakeCents, payoutCents: b.payoutCents })),
        });
      }).catch(() => { /* catch-up is best effort; the refreshed queries still show the result */ });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [tableId, userId, qc]);
}
