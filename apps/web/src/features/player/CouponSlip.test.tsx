import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { CouponSlip } from './CouponSlip';
import type { SlipPick } from './slip';
import type { TableView } from './types';
import type { Slip } from './useSlip';

const TABLE = {
  id: 't1', unit: 'points', status: 'open',
  limits: { minCents: 100, maxCents: 5_000, couponCapCents: 20_000, maxRounds: 20, marketMaxCents: {} },
  offered: [
    { slug: 'rainbow', name: 'Rainbow', group: 'popular', multiplier: 2.3 },
    { slug: 'any-pair', name: 'Any Pair', group: 'popular', multiplier: 5 },
  ],
} as unknown as TableView;

function fakeSlip(picks: SlipPick[], rounds: number): Slip {
  return {
    picks, rounds, sharedCents: picks[0]?.stakeCents ?? 100, serverError: null, busy: false,
    toggle: vi.fn(), setShared: vi.fn(), setStake: vi.fn(), setRounds: vi.fn(), clear: vi.fn(),
    loadPlayAgain: vi.fn(), place: vi.fn().mockResolvedValue(true),
  };
}

const renderSlip = (slip: Slip, balanceCents = 10_000) => render(
  <ToastProvider>
    <CouponSlip open onClose={() => undefined} table={TABLE} slip={slip} balanceCents={balanceCents} blockedBy={null} live={null} />
  </ToastProvider>,
);

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(), key: () => null, length: 0,
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('CouponSlip', () => {
  it('shows the commitment math, top win and duration', () => {
    renderSlip(fakeSlip([{ market: 'rainbow', stakeCents: 200 }, { market: 'any-pair', stakeCents: 200 }], 5));
    // 2 picks × 2 PTS × 5 flops = 20 PTS; top win (4.60 + 10) × 5 = 73 PTS; 5 × 2.2 = 11 min.
    expect(screen.getByRole('button', { name: /PLACE COUPON 20 PTS/ })).toBeEnabled();
    expect(screen.getByText(/2 picks · 2 PTS per flop × 5 flops/)).toBeInTheDocument();
    expect(screen.getByText(/Top win 73 PTS · about 11 min/)).toBeInTheDocument();
  });

  it('blocks placing over the coupon cap and explains why', () => {
    renderSlip(fakeSlip([{ market: 'rainbow', stakeCents: 5_000 }], 5), 1_000_000);
    expect(screen.getByRole('alert')).toHaveTextContent('over the 200 PTS limit');
    expect(screen.getByRole('button', { name: /PLACE COUPON/ })).toBeDisabled();
  });

  it('asks once per device before the first placement', async () => {
    const slip = fakeSlip([{ market: 'rainbow', stakeCents: 100 }], 1);
    renderSlip(slip);
    fireEvent.click(screen.getByRole('button', { name: /PLACE COUPON/ }));
    expect(slip.place).not.toHaveBeenCalled();
    expect(screen.getByText(/Once placed it is locked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Place coupon' }));
    expect(slip.place).toHaveBeenCalledTimes(1);
    expect(store.get('getflop_coupon_lock_ack')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: /PLACE COUPON/ }));
    expect(slip.place).toHaveBeenCalledTimes(2);
  });
});
