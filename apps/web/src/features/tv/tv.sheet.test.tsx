import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { TvLaunchSheet } from './index';

const api = vi.hoisted(() => ({
  claim: vi.fn(), cash: vi.fn(), tournament: vi.fn(), createPairing: vi.fn(), createLink: vi.fn(), sessions: vi.fn(), revoke: vi.fn(),
}));
vi.mock('./api', () => ({ tvApi: api }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') } }));
const socketHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock('../../lib/socket', () => ({
  useSocketEvent: (event: string, handler: (payload: unknown) => void) => { socketHandlers.set(event, handler); },
}));

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function renderSheet(kind: 'cash' | 'tournament' = 'cash') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <TvLaunchSheet open onClose={() => undefined} kind={kind} targetId="t-1" targetName="Table 1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  socketHandlers.clear();
  api.createPairing.mockResolvedValue({
    pairingId: 'p-1', pairingCode: '123456', expiresInMinutes: 10, expiresAt: inMinutes(10), tvPath: '/tv/cash', tvUrl: 'http://app/#/tv/cash',
  });
  api.sessions.mockResolvedValue({ sessions: [] });
});
afterEach(cleanup);

describe('TvLaunchSheet', () => {
  it('creates a code and shows it large with the TV address and expiry', async () => {
    renderSheet();
    expect(await screen.findByText('123 456')).toBeInTheDocument();
    expect(api.createPairing).toHaveBeenCalledWith('cash', 't-1');
    expect(screen.getByText('http://app/#/tv/cash')).toBeInTheDocument();
    expect(screen.getByText(/Code valid for (10:00|9:5\d)/)).toBeInTheDocument();
    expect(screen.getByText('A fresh code appears on its own every 10 minutes.')).toBeInTheDocument();
    expect(await screen.findByText('No TV is showing this right now.')).toBeInTheDocument();
  });

  it('refreshes the code when it runs out', async () => {
    api.createPairing
      .mockResolvedValueOnce({ pairingId: 'p-1', pairingCode: '111111', expiresInMinutes: 10, expiresAt: inMinutes(-1), tvPath: '', tvUrl: 'u' })
      .mockResolvedValueOnce({ pairingId: 'p-2', pairingCode: '222222', expiresInMinutes: 10, expiresAt: inMinutes(10), tvPath: '', tvUrl: 'u' });
    renderSheet();
    expect(await screen.findByText('222 222')).toBeInTheDocument();
    expect(api.createPairing).toHaveBeenCalledTimes(2);
  });

  it('confirms when the TV connects', async () => {
    renderSheet();
    await screen.findByText('123 456');
    act(() => socketHandlers.get('tv:connected')!({ pairingId: 'p-1', kind: 'cash', targetId: 'other', name: 'X' }));
    expect(screen.queryByText(/is now on the TV/)).toBeNull();
    act(() => socketHandlers.get('tv:connected')!({ pairingId: 'p-1', kind: 'cash', targetId: 't-1', name: 'Table 1' }));
    expect(await screen.findByText('Table 1 is now on the TV. Keep running it from this phone.')).toBeInTheDocument();
    expect(screen.getByText('TV connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pair another TV' }));
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(2));
  });

  it('creates a direct link with a QR', async () => {
    api.createLink.mockResolvedValue({ sessionId: 's-1', token: 'tk', expiresAt: inMinutes(1440), tvPath: '/tv/cash/tk', tvUrl: 'http://app/#/tv/cash/tk' });
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Use a direct link instead' }));
    expect(screen.getByText('Making a new link switches off the previous one.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText('http://app/#/tv/cash/tk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'http://app/#/tv/cash/tk');
  });

  it('lists connected TVs and disconnects one after confirmation', async () => {
    api.sessions.mockResolvedValue({
      sessions: [{ id: 's-9', kind: 'cash', via: 'pairing', createdAt: inMinutes(-5), expiresAt: inMinutes(1400), lastSeenAt: null }],
    });
    api.revoke.mockResolvedValue({ revoked: true });
    renderSheet();
    expect(await screen.findByText('Paired with a code')).toBeInTheDocument();
    expect(screen.getByText(/Not opened yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(screen.getByText('Disconnect this TV?')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Disconnect' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('s-9'));
    expect(await screen.findByText('TV disconnected')).toBeInTheDocument();
  });

  it('shows a translated error when a code cannot be created', async () => {
    const { ApiError } = await import('../../lib/api');
    api.createPairing.mockReset().mockRejectedValue(new ApiError('tv.table_closed', 409));
    renderSheet();
    expect(await screen.findByText('Open the table first, then launch the TV.')).toBeInTheDocument();
    expect(screen.getByText('Creating a code…')).toBeInTheDocument();
  });
});
