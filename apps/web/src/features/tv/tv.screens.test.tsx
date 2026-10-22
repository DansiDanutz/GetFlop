import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { DisplayScreen } from './DisplayScreen';
import { PairingScreen } from './PairingScreen';
import { saveDisplay } from './storage';
import { TvHome } from './TvHome';
import type { CashTvData } from './types';

const api = vi.hoisted(() => ({
  claim: vi.fn(), cash: vi.fn(), tournament: vi.fn(), createPairing: vi.fn(), createLink: vi.fn(), sessions: vi.fn(), revoke: vi.fn(),
}));
vi.mock('./api', () => ({ tvApi: api }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') } }));

type Listener = (payload?: unknown) => void;
const fakeSocket = vi.hoisted(() => {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    options: null as unknown,
    on(event: string, fn: Listener) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return this; },
    disconnect: vi.fn(),
    fire(event: string, payload?: unknown) { (listeners.get(event) ?? []).forEach((fn) => fn(payload)); },
  };
});
vi.mock('socket.io-client', () => ({
  io: (options: unknown) => { fakeSocket.options = options; return fakeSocket; },
}));

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderAt(path: string, element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tv" element={<TvHome />} />
            <Route path="/tv/cash" element={element} />
            <Route path="/tv/cash/:token" element={element} />
          </Routes>
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const FUTURE = '2099-01-01T00:00:00.000Z';
const payload = (): CashTvData => ({
  table: { name: 'Table 1', status: 'open', clubName: 'Sharks', roomName: null, joinCode: null, joinUrl: null },
  hand: null, markets: [], recent: [], bettingTimerSeconds: 30, serverNow: new Date().toISOString(), expiresAt: FUTURE,
});

/** Node 26 ships its own (disabled) localStorage that hides jsdom's; tests use an in-memory one. */
function installMemoryStorage(): void {
  const data = new Map<string, string>();
  const memory = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size; },
  };
  Object.defineProperty(window, 'localStorage', { value: memory, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: memory, configurable: true });
}

beforeEach(() => {
  installMemoryStorage();
  fakeSocket.listeners.clear();
  Object.values(api).forEach((fn) => fn.mockReset());
});
afterEach(cleanup);

describe('PairingScreen', () => {
  it('claims the code typed on a keyboard and opens the display', async () => {
    api.claim.mockResolvedValue({ displayToken: 'tok-1', expiresAt: FUTURE, tableName: 'Table 1' });
    api.cash.mockResolvedValue(payload());
    renderAt('/tv/cash', <PairingScreen kind="cash" />);
    expect(screen.getByText('Pair this TV with a Ring Game')).toBeInTheDocument();
    for (const key of ['1', '2', '3', '9', 'Backspace', '4', '5', '6']) fireEvent.keyDown(window, { key });
    await waitFor(() => expect(api.claim).toHaveBeenCalledWith('cash', '123456'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tv/cash/tok-1'));
    expect(JSON.parse(localStorage.getItem('getflop_tv_cash')!)).toEqual({ token: 'tok-1', expiresAt: FUTURE });
  });

  it('shows the server error and clears the code', async () => {
    api.claim.mockRejectedValue(new ApiError('tv.pairing_expired', 410));
    renderAt('/tv/cash', <PairingScreen kind="cash" />);
    for (const d of '65432') fireEvent.click(screen.getByRole('button', { name: d }));
    fireEvent.click(screen.getByRole('button', { name: '1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code has run out');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('skips pairing when a valid token is stored', async () => {
    saveDisplay('cash', { token: 'stored', expiresAt: FUTURE });
    api.cash.mockResolvedValue(payload());
    renderAt('/tv/cash', <PairingScreen kind="cash" />);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tv/cash/stored'));
  });

  it('the home page resumes a stored display', async () => {
    saveDisplay('cash', { token: 'home', expiresAt: FUTURE });
    api.cash.mockResolvedValue(payload());
    renderAt('/tv', <DisplayScreen kind="cash" />);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/tv/cash/home'));
  });
});

describe('DisplayScreen', () => {
  it('connects the TV socket with the display token and refetches on hand events', async () => {
    api.cash.mockResolvedValue(payload());
    renderAt('/tv/cash/tok-9', <DisplayScreen kind="cash" />);
    expect(await screen.findByText('Sharks · Table 1')).toBeInTheDocument();
    expect(fakeSocket.options).toMatchObject({ auth: { displayToken: 'tok-9' }, reconnectionAttempts: Infinity, reconnectionDelayMax: 10_000 });
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    act(() => fakeSocket.fire('tv:ready'));
    expect(screen.getByText('Live')).toBeInTheDocument();
    act(() => fakeSocket.fire('hand:started', { handNumber: 1 }));
    await waitFor(() => expect(api.cash).toHaveBeenCalledTimes(2));
  });

  it('reveals the flop, then refreshes after the animation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.cash.mockResolvedValue(payload());
      renderAt('/tv/cash/tok-r', <DisplayScreen kind="cash" />);
      await screen.findByText('Sharks · Table 1');
      act(() => fakeSocket.fire('hand:flop-revealed', { card1: 'Ah', card2: 'Kd', card3: '2c' }));
      expect(screen.getByLabelText('A♥')).toBeInTheDocument();
      act(() => fakeSocket.fire('hand:settled', {}));
      await act(async () => { vi.advanceTimersByTime(1_200); });
      await waitFor(() => expect(api.cash).toHaveBeenCalledTimes(2));
      expect(screen.queryByLabelText('A♥')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the expired screen on 410 and goes back to pairing', async () => {
    saveDisplay('cash', { token: 'old', expiresAt: FUTURE });
    api.cash.mockRejectedValue(new ApiError('tv.display_expired', 410));
    renderAt('/tv/cash/old', <DisplayScreen kind="cash" />);
    expect(await screen.findByText('This TV link has run out')).toBeInTheDocument();
    expect(localStorage.getItem('getflop_tv_cash')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/tv\/cash$/));
  });

  it('shows the revoked screen when staff disconnects the TV', async () => {
    api.cash.mockResolvedValue(payload());
    renderAt('/tv/cash/tok-x', <DisplayScreen kind="cash" />);
    await screen.findByText('Sharks · Table 1');
    act(() => fakeSocket.fire('tv:revoked', {}));
    expect(await screen.findByText('Staff disconnected this TV')).toBeInTheDocument();
  });

  it('a refused socket token triggers a refetch', async () => {
    api.cash.mockResolvedValue(payload());
    renderAt('/tv/cash/tok-y', <DisplayScreen kind="cash" />);
    await screen.findByText('Sharks · Table 1');
    act(() => fakeSocket.fire('connect_error', new Error('tv.display_expired')));
    await waitFor(() => expect(api.cash).toHaveBeenCalledTimes(2));
  });
});
