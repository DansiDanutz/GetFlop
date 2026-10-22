import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import type { TableView } from './types';
import { useSlip } from './useSlip';

const placeCoupon = vi.fn();
vi.mock('./data', async (orig) => ({ ...(await orig<typeof import('./data')>()), placeCoupon: (...args: unknown[]) => placeCoupon(...args) }));

const TABLE = {
  id: 't1', unit: 'points',
  limits: { minCents: 100, maxCents: 5_000, couponCapCents: 20_000, maxRounds: 20, marketMaxCents: {} },
  offered: [
    { slug: 'rainbow', name: 'Rainbow', group: 'popular', multiplier: 2.3 },
    { slug: 'trips-or-sf', name: 'Trips or SF', group: 'specials', multiplier: 170 },
  ],
} as unknown as TableView;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
);

beforeEach(() => { placeCoupon.mockReset(); });
afterEach(cleanup);

describe('useSlip', () => {
  it('adds picks at the shared amount clamped per market, and applies a new shared amount to all', () => {
    const { result } = renderHook(() => useSlip(TABLE), { wrapper });
    act(() => result.current.setShared(2_000));
    act(() => result.current.toggle('rainbow'));
    act(() => result.current.toggle('trips-or-sf'));
    expect(result.current.picks).toEqual([{ market: 'rainbow', stakeCents: 2_000 }, { market: 'trips-or-sf', stakeCents: 500 }]);
    act(() => result.current.setRounds(99));
    expect(result.current.rounds).toBe(20);
  });

  it('resets the slip after a successful placement', async () => {
    placeCoupon.mockResolvedValue({ couponId: 'c', rounds: 3, totalCommitmentCents: 300, balanceCents: 9_700, unit: 'points', isTournament: false, playsCurrentHand: true });
    const { result } = renderHook(() => useSlip(TABLE), { wrapper });
    act(() => result.current.toggle('rainbow'));
    act(() => result.current.setRounds(3));
    let placed = false;
    await act(async () => { placed = await result.current.place(); });
    expect(placed).toBe(true);
    expect(placeCoupon).toHaveBeenCalledWith('t1', [{ market: 'rainbow', stakeCents: 100 }], 3);
    expect(result.current.picks).toEqual([]);
    expect(result.current.rounds).toBe(1);
  });

  it('keeps the slip and remembers the server error until the slip changes', async () => {
    placeCoupon.mockRejectedValue(new ApiError('coupon.table_closed', 409));
    const { result } = renderHook(() => useSlip(TABLE), { wrapper });
    act(() => result.current.toggle('rainbow'));
    await act(async () => { await result.current.place(); });
    expect(result.current.serverError).toEqual({ code: 'coupon.table_closed', params: {} });
    expect(result.current.picks).toHaveLength(1);
    act(() => result.current.setRounds(2));
    expect(result.current.serverError).toBeNull();
  });

  it('loads a finished coupon for play again, or refuses when nothing fits', () => {
    const { result } = renderHook(() => useSlip(TABLE), { wrapper });
    let ok = false;
    act(() => { ok = result.current.loadPlayAgain([{ market: 'rainbow', stakeCents: 300 }, { market: 'any-pair', stakeCents: 100 }], 30); });
    expect(ok).toBe(true);
    expect(result.current.picks).toEqual([{ market: 'rainbow', stakeCents: 300 }]);
    expect(result.current.rounds).toBe(20);
    act(() => { ok = result.current.loadPlayAgain([{ market: 'any-pair', stakeCents: 100 }], 1); });
    expect(ok).toBe(false);
  });
});
