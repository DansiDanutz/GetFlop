import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { dealerApi, type Available, type DealerTable } from './api';
import { DealerTables } from './DealerTables';

const selectClub = vi.fn(async () => undefined);
vi.mock('../../state/session', () => ({
  useSession: () => ({
    user: { id: 'u1', displayName: 'Dana' },
    context: { club: { id: 'c1', name: 'Sharks', photoUrl: null }, surfaces: ['player', 'dealer'], roles: ['dealer'], capabilities: [] },
    selectClub, logout: vi.fn(), can: () => false,
  }),
}));

const table = (id: string, name: string, over: Partial<DealerTable> = {}): DealerTable => ({
  id, clubId: 'c1', name, game: 'nlh', kind: 'cash', status: 'open', isAutoDeal: false, dealerId: null, joinCode: 'JOIN',
  unit: 'points', lastHandNumber: 0, currentHand: null, lastHand: null, tournament: null, ...over,
});

function setup(opts: { held?: DealerTable | null; available?: Partial<Available>; notices?: { id: string; code: string; params: Record<string, string> }[] } = {}) {
  vi.spyOn(dealerApi, 'tables').mockResolvedValue({ tables: opts.held ? [opts.held] : [] });
  vi.spyOn(dealerApi, 'available').mockResolvedValue({ tables: [table('t2', 'Table 2')], needsApproval: false, pending: null, ...opts.available });
  vi.spyOn(dealerApi, 'notices').mockResolvedValue({ notices: opts.notices ?? [] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/dealer']}>
          <Routes>
            <Route path="/dealer" element={<DealerTables />} />
            <Route path="/dealer/table/:id" element={<p>console open</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DealerTables', () => {
  it('sits at an available table and opens the console', async () => {
    const sit = vi.spyOn(dealerApi, 'sit').mockResolvedValue({ status: 'seated', table: table('t2', 'Table 2') });
    setup();
    expect(await screen.findByText('You are not dealing any table — pick one below')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Sit here' }));
    expect(await screen.findByText('console open')).toBeInTheDocument();
    expect(sit).toHaveBeenCalledWith('t2');
  });

  it('asks to sit when the club needs approval, and shows the pending request with cancel', async () => {
    vi.spyOn(dealerApi, 'sit').mockResolvedValue({ status: 'requested', request: {} as never });
    const cancel = vi.spyOn(dealerApi, 'cancelRequest').mockResolvedValue(undefined);
    setup({ available: { needsApproval: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ask to sit here' }));
    expect(await screen.findByText('Asked to sit at Table 2 — waiting for approval')).toBeInTheDocument();
    cleanup();

    setup({ available: { needsApproval: true, pending: { id: 'r1', clubId: 'c1', clubName: 'Sharks', tableId: 't2', tableName: 'Table 2', status: 'pending', createdAt: '' } } });
    expect(await screen.findByText('Waiting for approval to sit at Table 2…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask to sit here' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('r1'));
  });

  it('offers to switch when seated at another table', async () => {
    const sw = vi.spyOn(dealerApi, 'switchTo').mockResolvedValue({ status: 'seated', table: table('t2', 'Table 2') });
    setup({ held: table('t1', 'Table 1', { clubName: 'Sharks', dealerId: 'u1' }) });
    expect(await screen.findByRole('button', { name: 'Open console' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Sit here' }));
    expect(await screen.findByText('You are dealing Table 1 (Sharks). Leave it?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, sit here' }));
    expect(await screen.findByText('console open')).toBeInTheDocument();
    expect(sw).toHaveBeenCalledWith('t2', 't1');
  });

  it('asks to finish a live hand first and goes to the held table in its club', async () => {
    const live = { id: 'h1', handNumber: 4, status: 'betting_open' } as DealerTable['currentHand'];
    setup({ held: table('t9', 'River 1', { clubId: 'c2', clubName: 'Riverside', currentHand: live }) });
    expect(await screen.findByText('You are still dealing River 1 (Riverside)')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Sit here' }));
    expect(await screen.findByText('Finish it there first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to River 1' }));
    expect(await screen.findByText('console open')).toBeInTheDocument();
    expect(selectClub).toHaveBeenCalledWith('c2');
  });

  it('stands up from a table held in another club, and dismisses notices', async () => {
    const leave = vi.spyOn(dealerApi, 'leaveHeld').mockResolvedValue({ table: 'River 1', club: 'Riverside' });
    const read = vi.spyOn(dealerApi, 'readNotice').mockResolvedValue({ read: true });
    setup({
      held: table('t9', 'River 1', { clubId: 'c2', clubName: 'Riverside' }),
      notices: [{ id: 'n1', code: 'dealer.wanted_elsewhere', params: { wantedBy: 'Floor', table: 'River 1', club: 'Riverside' } }],
    });
    expect(await screen.findByText(/Floor wants you to deal/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith('n1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Stand up from River 1 (Riverside)' }));
    expect(await screen.findByText('You stood up from River 1 (Riverside)')).toBeInTheDocument();
    expect(leave).toHaveBeenCalled();
  });
});
