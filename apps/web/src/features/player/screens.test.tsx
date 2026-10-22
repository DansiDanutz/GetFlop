import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HeatContent } from './HeatSheet';
import { TableStage } from './TableStage';
import type { HandStats, HeatBoard, HeatMarket, TableView } from './types';

afterEach(cleanup);

const market = (slug: string, over: Partial<HeatMarket> = {}): HeatMarket => ({
  slug, name: slug, hits: 10, rate: 0.2, expected: 0.2, band: { low: 0.1, high: 0.3 }, judged: true, state: 'normal',
  hitSeq: [true, false, true], ...over,
});
const board = (over: Partial<HeatBoard>): HeatBoard => ({
  window: 50, flopsCounted: 50, markets: [market('rainbow'), market('any-pair')], hot: [], cold: [], ...over,
});

describe('HeatContent', () => {
  it('asks for more flops before saying anything', () => {
    render(<HeatContent board={board({ flopsCounted: 3 })} />);
    expect(screen.getByText(/3 hands in/)).toBeInTheDocument();
    expect(screen.getByText(/not a prediction/)).toBeInTheDocument();
  });

  it('dims the bars while the window fills', () => {
    const { container } = render(<HeatContent board={board({ flopsCounted: 20 })} />);
    expect(screen.getByText(/20 of 50 flops so far/)).toBeInTheDocument();
    expect(container.querySelector('.pl-heat.dim')).not.toBeNull();
  });

  it('names hot and cold markets with bead strips', () => {
    const { container } = render(<HeatContent board={board({
      markets: [market('rainbow', { state: 'hot' }), market('has-ace', { state: 'hot' }), market('any-pair', { state: 'cold' })],
      hot: ['rainbow', 'has-ace'], cold: ['any-pair'],
    })} />);
    expect(screen.getByText('Showing up lately: Rainbow and Ace. Gone quiet: Pair.')).toBeInTheDocument();
    expect(container.querySelectorAll('.pl-beads')).toHaveLength(3);
  });

  it('is calm when every bar is inside its band', () => {
    render(<HeatContent board={board({})} />);
    expect(screen.getByText(/every bar sits inside its band/)).toBeInTheDocument();
  });
});

describe('TableStage', () => {
  const table = {
    id: 't', unit: 'points', status: 'open', dealerId: 'd', isAutoDeal: false, lastHandNumber: 7,
    currentHand: null, lastHand: { id: 'h7', status: 'settled', flop: ['Qc', '7h', '3s'] },
  } as unknown as TableView;
  const stats: HandStats = { hand: { id: 'h7', handNumber: 7, status: 'settled' }, players: 3, picks: 5, playedCents: 1_250, bettingTimerSeconds: 30 };

  it('shows the tiles and the settled flop', () => {
    render(<TableStage table={table} stats={stats} phase="settled" revealed={null} timerSeconds={null} noMorePicks={false} />);
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.getByText('12.50')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Q♣' })).toBeInTheDocument();
  });

  it('shows the countdown and card backs while picks are open, and the overlay on no more picks', () => {
    const open = { ...table, currentHand: { id: 'h8', handNumber: 8, status: 'betting_open', bettingClosesAt: new Date(Date.now() + 20_000).toISOString() } } as unknown as TableView;
    render(<TableStage table={open} stats={stats} phase="open" revealed={null} timerSeconds={30} noMorePicks />);
    expect(screen.getByRole('timer')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Face-down card' })).toHaveLength(3);
    expect(screen.getByRole('alert')).toHaveTextContent('NO MORE PICKS');
  });

  it('flips the revealed flop of the live hand', () => {
    const closed = { ...table, currentHand: { id: 'h8', handNumber: 8, status: 'betting_closed' } } as unknown as TableView;
    const { container } = render(<TableStage table={closed} stats={stats} phase="closed" revealed={{ handId: 'h8', cards: ['Ah', 'Kd', 'Js'] }} timerSeconds={null} noMorePicks={false} />);
    expect(container.querySelector('.pl-reveal')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'A♥' })).toBeInTheDocument();
  });
});
