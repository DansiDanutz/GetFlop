import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { dealerApi, type CurrentHand, type DealerTable, type Hand } from './api';
import { DealerConsole } from './DealerConsole';
import { DealerShell } from './DealerShell';

type Handler = (payload: unknown) => void;
const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  return {
    handlers,
    on: (e: string, f: (p: unknown) => void) => { if (!handlers.has(e)) handlers.set(e, new Set()); handlers.get(e)!.add(f); },
    off: (e: string, f: (p: unknown) => void) => { handlers.get(e)?.delete(f); },
    emit: () => undefined,
    fire: (e: string, p: unknown) => { handlers.get(e)?.forEach((f) => f(p)); },
  };
});

vi.mock('../../lib/socket', () => ({
  getSocket: () => socket,
  onSocketStatus: () => () => undefined,
  useTableRoom: () => undefined,
  useSocketEvent: (event: string, handler: Handler, deps: unknown[] = []) => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => { const f = (p: unknown) => handler(p); socket.on(event, f); return () => socket.off(event, f); }, [event, ...deps]);
  },
}));

vi.mock('../../state/session', () => ({
  useSession: () => ({
    user: { id: 'u1', displayName: 'Dana' },
    context: { club: { id: 'c1', name: 'Sharks', photoUrl: null }, surfaces: ['dealer'], roles: ['dealer'], capabilities: [] },
    selectClub: vi.fn(), logout: vi.fn(), can: () => false,
  }),
}));

const hand = (over: Partial<Hand> = {}): Hand => ({
  id: 'h5', handNumber: 5, status: 'betting_open', flop: null, totalBets: 0, winningBets: 0, totalWageredCents: 0,
  totalPaidOutCents: 0, bettingClosesAt: new Date(Date.now() + 20_000).toISOString(), dealtBy: 'dealer',
  createdAt: new Date(Date.now() - 10_000).toISOString(), settledAt: null, ...over,
});
const settled = hand({ id: 'h4', handNumber: 4, status: 'settled', flop: ['Qc', '7h', '3s'], totalBets: 6, winningBets: 2, totalWageredCents: 1200, totalPaidOutCents: 920, bettingClosesAt: null });
const table = (over: Partial<DealerTable> = {}): DealerTable => ({
  id: 't1', clubId: 'c1', name: 'Table 1', game: 'nlh', kind: 'cash', status: 'open', isAutoDeal: false, dealerId: 'u1',
  joinCode: 'JOIN1', unit: 'points', lastHandNumber: 4, currentHand: null, lastHand: settled, tournament: null, ...over,
});

function mockState(current: Partial<CurrentHand>) {
  return vi.spyOn(dealerApi, 'current').mockResolvedValue({ table: table(), hand: null, live: { players: 0, picks: 0 }, ...current });
}

function renderConsole() {
  vi.spyOn(dealerApi, 'hands').mockResolvedValue({
    hands: [settled, hand({ id: 'h3', handNumber: 3, status: 'cancelled', bettingClosesAt: null })], unit: 'points',
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/dealer/table/t1']}>
          <Routes>
            <Route path="/dealer/table/:tableId" element={<DealerShell><DealerConsole /></DealerShell>} />
            <Route path="/dealer" element={<p>table list</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); socket.handlers.clear(); });

describe('DealerConsole', () => {
  it('shows the table, the last flop and recent hands, and starts a hand', async () => {
    mockState({});
    const start = vi.spyOn(dealerApi, 'startHand').mockResolvedValue({ hand: hand(), bettingTimerSeconds: 30 });
    renderConsole();
    expect(await screen.findByRole('heading', { name: 'Table 1' })).toBeInTheDocument();
    expect(screen.getAllByText('Hand #4').length).toBeGreaterThan(0);
    expect(await screen.findByText('won 9.20 PTS')).toBeInTheDocument();
    expect(screen.getByText('cancelled')).toBeInTheDocument();
    expect(screen.getByText('Picks: 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'NEW HAND' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('t1'));
  });

  it('runs picks open → closed and opens the flop picker by itself', async () => {
    const current = mockState({ hand: hand(), live: { players: 2, picks: 3 } });
    const close = vi.spyOn(dealerApi, 'noMorePicks').mockResolvedValue({ hand: hand({ status: 'betting_closed' }) });
    renderConsole();
    expect(await screen.findByText('Players: 2 · Picks: 3')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the flop')).toBeInTheDocument();

    current.mockResolvedValue({ table: table(), hand: hand({ status: 'betting_closed' }), live: { players: 2, picks: 3 } });
    fireEvent.click(screen.getByRole('button', { name: 'NO MORE PICKS' }));
    await waitFor(() => expect(close).toHaveBeenCalledWith('t1'));
    act(() => socket.fire('hand:betting-closed', { tableId: 't1', handId: 'h5' }));
    expect(await screen.findByRole('heading', { name: 'Select the flop (0/3)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('heading', { name: 'Select the flop (0/3)' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ENTER FLOP' }));
    expect(screen.getByRole('heading', { name: 'Select the flop (0/3)' })).toBeInTheDocument();
  });

  it('cancels a hand after confirmation and refreshes on coupon:placed', async () => {
    const current = mockState({ hand: hand() });
    const cancel = vi.spyOn(dealerApi, 'cancelHand').mockResolvedValue({ hand: hand({ status: 'cancelled' }) });
    renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: '✕ CANCEL' }));
    expect(screen.getByText('Every pick on this hand is refunded to the players.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the hand' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('t1'));
    expect(await screen.findByText('Hand cancelled — picks refunded')).toBeInTheDocument();

    const calls = current.mock.calls.length;
    act(() => socket.fire('coupon:placed', { tableId: 'other' }));
    act(() => socket.fire('coupon:placed', { tableId: 't1', couponId: 'c' }));
    await waitFor(() => expect(current.mock.calls.length).toBe(calls + 1));
  });

  it('stands up from the menu after confirmation', async () => {
    mockState({});
    const leave = vi.spyOn(dealerApi, 'leave').mockResolvedValue({ table: table({ dealerId: null }) });
    renderConsole();
    await screen.findByRole('heading', { name: 'Table 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(screen.getByRole('tab', { name: 'Always compact' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Always full' }));
    expect(screen.getByRole('tab', { name: 'Always full' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show table QR' }));
    expect(await screen.findByText(/#\/join\/JOIN1$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stand up' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Stand up' }).at(-1)!);
    expect(await screen.findByText('table list')).toBeInTheDocument();
    expect(leave).toHaveBeenCalledWith('t1');
  });

  it('shows auto-deal and not-seated states without hand buttons', async () => {
    mockState({ table: table({ isAutoDeal: true }) });
    renderConsole();
    expect(await screen.findByText('Next hand starting automatically…')).toBeInTheDocument();
    cleanup();
    mockState({ table: table({ dealerId: 'someone' }) });
    renderConsole();
    expect(await screen.findByText('You are not dealing this table.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'NEW HAND' })).toBeNull();
  });
});

describe('dealer pushes', () => {
  it('toasts seat changes and moves the dealer, and shows notices', async () => {
    mockState({});
    renderConsole();
    await screen.findByRole('heading', { name: 'Table 1' });
    act(() => socket.fire('notice:new', { code: 'dealer.wanted_elsewhere', params: { wantedBy: 'Floor', table: 'T9', club: 'River' } }));
    expect(await screen.findByText('Floor wants you to deal, but you are still seated at T9 (River). Stand up there first.')).toBeInTheDocument();
    act(() => socket.fire('dealer:seat', { status: 'bogus', tableId: 't1', tableName: 'Table 1' }));
    act(() => socket.fire('dealer:seat', { status: 'unseated', tableId: 't1', tableName: 'Table 1' }));
    expect(await screen.findByText('The floor stood you up from Table 1')).toBeInTheDocument();
    expect(await screen.findByText('table list')).toBeInTheDocument();
  });
});
