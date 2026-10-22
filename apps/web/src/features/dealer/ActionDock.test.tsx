import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionDock } from './ActionDock';

afterEach(cleanup);

function dock(mode: Parameters<typeof ActionDock>[0]['mode'], extra: Partial<Parameters<typeof ActionDock>[0]> = {}) {
  const handlers = { onNewHand: vi.fn(), onNoMorePicks: vi.fn(), onEnterFlop: vi.fn(), onCancel: vi.fn() };
  render(<ActionDock mode={mode} live={{ players: 0, picks: 0 }} busy={false} closing={false} coach={false} {...handlers} {...extra} />);
  return handlers;
}

describe('ActionDock', () => {
  it('offers NEW HAND when no hand is live', () => {
    const h = dock('new');
    fireEvent.click(screen.getByRole('button', { name: 'NEW HAND' }));
    expect(h.onNewHand).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '✕ CANCEL' })).toBeNull();
  });

  it('shows the live picks, NO MORE PICKS and CANCEL while picks are open', () => {
    const h = dock('open');
    expect(screen.getByText('No picks yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'NO MORE PICKS' }));
    fireEvent.click(screen.getByRole('button', { name: '✕ CANCEL' }));
    expect(h.onNoMorePicks).toHaveBeenCalled();
    expect(h.onCancel).toHaveBeenCalled();
    cleanup();
    dock('open', { live: { players: 3, picks: 7 }, closing: true });
    expect(screen.getByText('Players: 3 · Picks: 7')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Closing picks…' })).toBeInTheDocument();
  });

  it('offers ENTER FLOP and CANCEL once picks are closed', () => {
    const h = dock('closed');
    fireEvent.click(screen.getByRole('button', { name: 'ENTER FLOP' }));
    expect(h.onEnterFlop).toHaveBeenCalled();
  });

  it('says the next hand starts automatically on auto-dealt tables, and shows the coach mark', () => {
    dock('auto');
    expect(screen.getByText('Next hand starting automatically…')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    dock('new', { coach: true, busy: true });
    expect(screen.getByRole('note')).toHaveTextContent('Every hand starts from this button');
    expect(screen.getByRole('button', { name: 'NEW HAND' })).toBeDisabled();
  });
});
