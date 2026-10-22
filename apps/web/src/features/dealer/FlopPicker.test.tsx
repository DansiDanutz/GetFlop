import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { dealerApi } from './api';
import { FlopPicker } from './FlopPicker';

vi.mock('./scanImage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scanImage')>()),
  photoToScanBase64: vi.fn(async () => 'BASE64'),
}));

function setWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function renderPicker(overrides: Partial<Parameters<typeof FlopPicker>[0]> = {}) {
  const props = {
    tableId: 't1', handId: 'h1', currentHandId: () => 'h1', onClose: vi.fn(), onSettled: vi.fn(), ...overrides,
  };
  render(<ToastProvider><FlopPicker {...props} /></ToastProvider>);
  return props;
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const pickCard = (rank: string, suit: RegExp) => { click(rank); click(suit); };

beforeEach(() => setWidth(375));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('FlopPicker, compact layout', () => {
  it('enters three cards rank-then-suit, reviews and settles', async () => {
    const enter = vi.spyOn(dealerApi, 'enterFlop').mockResolvedValue({ hand: {} as never });
    const props = renderPicker();
    expect(screen.getByRole('heading', { name: 'Select the flop (0/3)' })).toBeInTheDocument();
    expect(screen.getByText('Card 1 · choose the rank')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto · Compact' })).toBeInTheDocument();

    click('A');
    expect(screen.getByText('Card 1 · choose the suit for A')).toBeInTheDocument();
    expect(screen.getByText('A?')).toBeInTheDocument();
    click(/Hearts/);
    expect(screen.getByRole('heading', { name: 'Select the flop (1/3)' })).toBeInTheDocument();

    pickCard('10', /Diamonds/);
    pickCard('2', /Clubs/);
    expect(screen.getByText('Check all three cards before settlement')).toBeInTheDocument();
    click('CONFIRM FLOP');
    expect(screen.getByText('Players will see exactly these cards. Settlement is final.')).toBeInTheDocument();
    await act(async () => { click('Confirm & settle'); });
    expect(enter).toHaveBeenCalledWith('t1', ['Ah', 'Td', '2c']);
    expect(props.onSettled).toHaveBeenCalled();
  });

  it('refuses a card already chosen and lets a filled slot be replaced', () => {
    renderPicker();
    pickCard('A', /Hearts/);
    pickCard('A', /Hearts/);
    expect(screen.getByText('That card is already in the flop')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Select the flop (1/3)' })).toBeInTheDocument();

    click('Back');
    click('Card 1: A♥');
    expect(screen.getByText('Change card 1 · replacing A♥')).toBeInTheDocument();
    pickCard('K', /Spades/);
    expect(screen.getByRole('button', { name: 'Card 1: K♠' })).toBeInTheDocument();
    click('Clear');
    expect(screen.getByRole('heading', { name: 'Select the flop (0/3)' })).toBeInTheDocument();
  });

  it('switches to the full layout from the header toggle', () => {
    renderPicker();
    click('Auto · Compact');
    expect(screen.getByRole('button', { name: 'Full' })).toBeInTheDocument();
    expect(screen.getByText('Tap 3 more below')).toBeInTheDocument();
  });
});

describe('FlopPicker, full layout', () => {
  it('toggles cards from the 52-card grid', () => {
    setWidth(1280);
    renderPicker();
    expect(screen.getByRole('button', { name: 'Auto · Full' })).toBeInTheDocument();
    click('A Spades');
    click('K Hearts');
    click('A Spades');
    expect(screen.getByText('Tap 2 more below')).toBeInTheDocument();
    click('Q Clubs');
    click('J Diamonds');
    expect(screen.getByRole('button', { name: 'CONFIRM FLOP' })).toBeInTheDocument();
    click('2 Clubs');
    expect(screen.getByText('Three cards are chosen — tap one to take it out first')).toBeInTheDocument();
  });
});

describe('FlopPicker scan', () => {
  const photo = () => {
    const input = screen.getByTestId('scan-input');
    fireEvent.change(input, { target: { files: [new File(['x'], 'flop.jpg', { type: 'image/jpeg' })] } });
  };

  it('pre-fills the recognised cards for confirmation', async () => {
    const scan = vi.spyOn(dealerApi, 'scanFlop').mockResolvedValue({ cards: ['Ah', 'Kd'], confidence: 'high' });
    renderPicker();
    photo();
    await waitFor(() => expect(screen.getByText('2 of 3 cards recognised — tap the rest by hand')).toBeInTheDocument());
    expect(scan).toHaveBeenCalledWith('t1', 'BASE64');
    expect(screen.getByRole('button', { name: 'Card 2: K♦' })).toBeInTheDocument();
  });

  it('shows the unavailable message', async () => {
    vi.spyOn(dealerApi, 'scanFlop').mockRejectedValue(new ApiError('scan.unavailable', 503));
    renderPicker();
    photo();
    await waitFor(() => expect(screen.getByText('Card scanning is not available right now. Tap the cards by hand.')).toBeInTheDocument());
  });

  it('discards the result when the hand changed meanwhile', async () => {
    vi.spyOn(dealerApi, 'scanFlop').mockResolvedValue({ cards: ['Ah', 'Kd', '2c'], confidence: 'high' });
    renderPicker({ currentHandId: () => 'h2' });
    photo();
    await waitFor(() => expect(dealerApi.scanFlop).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Select the flop (0/3)' })).toBeInTheDocument();
  });
});
