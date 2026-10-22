import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { api } from '../../lib/api';
import type { RequestLists } from './amounts';
import { PointsSheet } from './PointsSheet';

vi.mock('../../lib/api', async (orig) => {
  const real = await orig<typeof import('../../lib/api')>();
  return { ...real, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

const get = vi.mocked(api.get);
const post = vi.mocked(api.post);
let requests: RequestLists;

function setup(balanceCents: number) {
  get.mockImplementation(async (path: string) => {
    if (path === '/player/balance') return { clubId: 'c1', balanceCents };
    if (path === '/player/requests') return requests;
    if (path === '/player/my-games') return { games: [], live: [], recent: [], totals: { committedCents: 0, wonCents: 0, stillAtStakeCents: 300, liveCoupons: 1 } };
    throw new Error(`unexpected ${path}`);
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}><ToastProvider><PointsSheet open onClose={() => undefined} /></ToastProvider></QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  requests = { reloads: [], cashouts: [] };
});

describe('PointsSheet', () => {
  it('shows the balance and riding figures and sends a request', async () => {
    post.mockResolvedValue({});
    setup(1_250);
    expect(await screen.findByText('12.50 PTS')).toBeInTheDocument();
    expect(screen.getByText('3 PTS')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Amount'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Send request · 20 PTS' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/player/reload-request', { amountCents: 2_000 }));
  });

  it('caps returns at the balance and offers All', async () => {
    post.mockResolvedValue({});
    setup(1_250);
    await userEvent.click(await screen.findByRole('tab', { name: 'Return to club' }));
    await userEvent.type(screen.getByLabelText('Amount'), '13');
    expect(screen.getByRole('alert')).toHaveTextContent('more than your balance');
    expect(screen.getByRole('button', { name: /Send request/ })).toBeDisabled();
    await userEvent.clear(screen.getByLabelText('Amount'));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('12.5');
    await userEvent.click(screen.getByRole('button', { name: 'Send request · 12.50 PTS' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/player/cashout-request', { amountCents: 1_250 }));
  });

  it('shows the waiting request instead of the form', async () => {
    requests = { reloads: [{ id: 'r1', kind: 'load', amountCents: 5_000, status: 'pending', createdAt: '2026-09-24T10:00:00Z' }], cashouts: [] };
    setup(0);
    expect(await screen.findByText('Your request for 50 PTS is waiting for the club.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
  });
});
