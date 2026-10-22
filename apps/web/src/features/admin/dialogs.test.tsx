import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { api, ApiError } from '../../lib/api';
import type { BetRow, BetType } from './api';
import { VoidSheet } from './Hands';
import { EditMarketSheet } from './Markets';

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><ToastProvider>{children}</ToastProvider></QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bet: BetRow = {
  id: 'b1', userId: 'u1', username: 'alice', displayName: 'Alice', market: 'rainbow', marketName: 'Rainbow', stakeCents: 200,
  multiplier: 2.3, status: 'won', payoutCents: 460, voidReason: null, unit: 'points',
};

describe('void dialog', () => {
  it('needs a reason before it voids, then reports the corrected player', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ playerName: 'Alice' });
    const onClose = vi.fn();
    wrap(<VoidSheet bet={bet} onClose={onClose} />);
    expect(screen.getByText('The pick won: the win is taken back and the stake returned.')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Void' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Wrong cards entered ' } });
    fireEvent.click(submit);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/admin/bets/b1/void', { reason: 'Wrong cards entered' });
    expect(await screen.findByText('Alice’s pick is voided and the balance is corrected')).toBeInTheDocument();
  });

  it('shows the server error and stays open', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError('admin.bet_already_voided', 409));
    const onClose = vi.fn();
    wrap(<VoidSheet bet={{ ...bet, status: 'lost' }} onClose={onClose} />);
    expect(screen.getByText('The pick lost: its stake goes back to the player.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Misdeal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    expect(await screen.findByText('This pick is already voided.')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

const rainbow: BetType = {
  slug: 'rainbow', name: 'Rainbow', category: 'popular', payoutOdds: 1.3, multiplier: 2.3, probability: 0.397647,
  fairOdds: 1.5148, fairMultiplier: 2.5148, edge: 0.085412, isActive: true, liveCoupons: 3, unresolvedCents: 1_500,
};

describe('market price editor', () => {
  it('highlights a negative edge and confirms with the live-coupon impact', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ betType: { ...rainbow, multiplier: 3 }, negativeEdge: true });
    const onClose = vi.fn();
    wrap(<EditMarketSheet market={rainbow} onClose={onClose} />);
    const review = screen.getByRole('button', { name: 'Review the change' });
    expect(review).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Pays (X:1)'), { target: { value: '0' } });
    expect(screen.getByText('The price must be above 0 (X:1).')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Pays (X:1)'), { target: { value: '2' } });
    expect(screen.getByText('×3')).toBeInTheDocument();
    expect(screen.getByText(/Negative edge/)).toBeInTheDocument();
    fireEvent.click(review);

    expect(screen.getByText('Price ×2.3 → ×3')).toBeInTheDocument();
    expect(screen.getByText('House edge 8.5% → -19.3%')).toHaveClass('neg');
    expect(screen.getByText(/3 live coupons include it/)).toBeInTheDocument();
    expect(screen.getByText('Live coupons keep the price they were bought at.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith('/admin/bet-types/rainbow', { payout_odds: 2, is_active: true });
  });

  it('can take a market off the board without changing its price', () => {
    wrap(<EditMarketSheet market={rainbow} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }));
    expect(screen.getByText('Taken off the board')).toBeInTheDocument();
    expect(screen.getByText('Price ×2.3 → ×2.3')).toBeInTheDocument();
  });
});
