import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CashTvView } from './CashTvView';
import { TournamentTvView } from './TournamentTvView';
import type { CashTvData, TournamentTvData, TvHand } from './types';

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,AAAA') } }));

const NOW = '2026-09-24T18:00:00.000Z';

afterEach(cleanup);

function cash(overrides: Partial<CashTvData> = {}): CashTvData {
  return {
    table: { name: 'Table 1', status: 'open', clubName: 'Sharks', roomName: 'Main', joinCode: 'AB12CD34', joinUrl: 'http://x/#/join/AB12CD34' },
    hand: null, markets: [], recent: [], bettingTimerSeconds: 30, serverNow: NOW, expiresAt: NOW, ...overrides,
  };
}

function hand(overrides: Partial<TvHand>): TvHand {
  return {
    handNumber: 7, status: 'betting_open', cards: null, winningMarkets: [], bettingClosesAt: null,
    players: 0, bets: 0, stakedCents: 0, paidOutCents: 0, winners: 0, ...overrides,
  };
}

describe('CashTvView', () => {
  it('shows the header, the join code and the waiting state', async () => {
    render(<CashTvView data={cash()} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('Sharks · Main · Table 1')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the next flop')).toBeInTheDocument();
    expect(screen.getByText('Table code AB12CD34')).toBeInTheDocument();
    expect(screen.getByText('No flops settled yet')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(await screen.findByAltText('QR code')).toBeInTheDocument();
  });

  it('shows off air for a closed table and reconnecting when the socket drops', () => {
    render(<CashTvView data={cash({ table: { ...cash().table, status: 'closed', joinUrl: null } })} connection="reconnecting" reveal={null} offsetMs={0} />);
    expect(screen.getByText('Off air')).toBeInTheDocument();
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByText('No join code for this table')).toBeInTheDocument();
  });

  it('shows the countdown and popular markets while picks are open', () => {
    const closes = new Date(Date.now() + 20_000).toISOString();
    const data = cash({
      hand: hand({ bettingClosesAt: closes }),
      markets: [{ slug: 'rainbow', name: 'Rainbow', picks: 4, players: 3 }, { slug: 'any-pair', name: 'Any Pair', picks: 1, players: 1 }],
    });
    render(<CashTvView data={data} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('Picks are open')).toBeInTheDocument();
    expect(screen.getByText('Hand #7')).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/2\ds|20s|19s/);
    expect(screen.getByText('Rainbow')).toBeInTheDocument();
    expect(screen.getByText('4 picks')).toBeInTheDocument();
  });

  it('shows no picks yet with an empty market list', () => {
    render(<CashTvView data={cash({ hand: hand({}) })} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('No picks yet')).toBeInTheDocument();
  });

  it('shows the flop is coming when picks are closed', () => {
    render(<CashTvView data={cash({ hand: hand({ status: 'betting_closed' }) })} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('The flop is on its way')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Face-down card')).toHaveLength(3);
  });

  it('shows the result with markets and totals, and the reveal before the refresh', () => {
    const settled = hand({
      status: 'settled', cards: ['Qc', '7h', '3s'], winningMarkets: [{ slug: 'rainbow', name: 'Rainbow' }],
      players: 2, bets: 3, stakedCents: 900, paidOutCents: 460, winners: 1,
    });
    const data = cash({ hand: settled, recent: [{ handNumber: 7, cards: ['Qc', '7h', '3s'], winningMarkets: ['rainbow'] }] });
    const { rerender } = render(<CashTvView data={data} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('Markets that came')).toBeInTheDocument();
    expect(screen.getByText('Rainbow')).toBeInTheDocument();
    expect(screen.getByText('9 PTS')).toBeInTheDocument();
    expect(screen.getByText('4.60 PTS')).toBeInTheDocument();
    expect(screen.getByText('#7')).toBeInTheDocument();

    rerender(<CashTvView data={cash({ hand: hand({ status: 'betting_closed' }) })} connection="live" reveal={['Ah', 'Kd', '2c']} offsetMs={0} />);
    expect(screen.getByLabelText('A♥')).toBeInTheDocument();

    rerender(<CashTvView data={cash({ hand: { ...settled, winningMarkets: [] } })} connection="live" reveal={null} offsetMs={0} />);
    expect(screen.getByText('No market came this time')).toBeInTheDocument();
  });
});

function tournament(overrides: Partial<TournamentTvData> = {}): TournamentTvData {
  return {
    tournament: { name: 'Friday Freeze', status: 'running', totalHands: 30, endCondition: 'hands' },
    currentHand: { handNumber: 12, status: 'settled', cards: ['Ah', 'Kd', '2c'], winningMarkets: [{ slug: 'has-ace', name: 'Contains an Ace' }], bettingClosesAt: null },
    level: {
      current: { levelNumber: 2, minBetChips: 20_000, maxBetChips: -1, startHand: 11, endHand: 20 },
      next: { levelNumber: 3, minBetChips: 40_000, maxBetChips: -1, startHand: 21, endHand: 30 },
      isFinal: false,
    },
    prizePoolCents: 150_000, guaranteed: true, payouts: [{ place: 1, amountCents: 100_000 }], entrants: 3, playersLeft: 2,
    leaderboard: [
      { rank: 1, name: 'Cleo', chips: 1_800_000, status: 'playing', place: null, payoutCents: 0 },
      { rank: 3, name: 'Bob', chips: 0, status: 'finished', place: 3, payoutCents: 0 },
    ],
    more: 4, serverNow: NOW, expiresAt: NOW, ...overrides,
  };
}

describe('TournamentTvView', () => {
  it('shows hand, level, prizes, players left and the leaderboard', () => {
    render(<TournamentTvView data={tournament()} connection="live" reveal={null} />);
    expect(screen.getByText('Live tournament')).toBeInTheDocument();
    expect(screen.getByText('Hand 12 of 30')).toBeInTheDocument();
    expect(screen.getByText('Level 2')).toBeInTheDocument();
    expect(screen.getByText('No limit')).toBeInTheDocument();
    expect(screen.getByText('Ends after hand #20')).toBeInTheDocument();
    expect(screen.getByText(/Next: level 3/)).toHaveTextContent('Starts at hand #21');
    expect(screen.getByText('1,500 PTS')).toBeInTheDocument();
    expect(screen.getByText('Guaranteed')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText('Cleo')).toBeInTheDocument();
    expect(screen.getByText('18,000 TC')).toBeInTheDocument();
    expect(screen.getByText('Out')).toBeInTheDocument();
    expect(screen.getByText('+4 more')).toBeInTheDocument();
    expect(screen.getByText('Contains an Ace')).toBeInTheDocument();
  });

  it('shows final results, the final level and an empty field', () => {
    const data = tournament({
      tournament: { name: 'Done', status: 'finished', totalHands: null, endCondition: 'manual' },
      currentHand: null, leaderboard: [], more: 0,
      level: { current: { levelNumber: 3, minBetChips: 400, maxBetChips: 800, startHand: 21, endHand: 30 }, next: null, isFinal: true },
    });
    render(<TournamentTvView data={data} connection="live" reveal={null} />);
    expect(screen.getByText('Final results')).toBeInTheDocument();
    expect(screen.getByText('Tournament over')).toBeInTheDocument();
    expect(screen.getByText('Not started yet')).toBeInTheDocument();
    expect(screen.getByText('Final level')).toBeInTheDocument();
    expect(screen.getByText('8 TC')).toBeInTheDocument();
    expect(screen.getByText('No players registered yet')).toBeInTheDocument();
  });

  it('labels an upcoming tournament and a manual end', () => {
    const data = tournament({ tournament: { name: 'Soon', status: 'upcoming', totalHands: null, endCondition: 'manual' }, level: { current: null, next: null, isFinal: false } });
    render(<TournamentTvView data={data} connection="reconnecting" reveal={['2c', '3d', '4h']} />);
    expect(screen.getByText('Starting soon')).toBeInTheDocument();
    expect(screen.getByText('Hand 12')).toBeInTheDocument();
    expect(screen.queryByText(/Level/)).toBeNull();
  });
});
