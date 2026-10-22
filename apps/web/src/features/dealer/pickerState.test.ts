import { describe, expect, it } from 'vitest';
import {
  activeSlot, EMPTY_PICKER, filledCount, flopOf, pickerStep, type PickerAction, type PickerState,
} from './pickerState';

function run(actions: PickerAction[], from: PickerState = EMPTY_PICKER): PickerState {
  return actions.reduce((s, a) => pickerStep(s, a).state, from);
}
const pick = (rank: string, suit: string): PickerAction[] => [{ type: 'rank', rank }, { type: 'suit', suit }];

describe('compact flow (rank then suit)', () => {
  it('fills the slots in order and completes the flop', () => {
    const s1 = run([{ type: 'rank', rank: 'A' }]);
    expect(s1.pendingRank).toBe('A');
    expect(activeSlot(s1)).toBe(0);
    const done = run([...pick('A', 'h'), ...pick('T', 'd'), ...pick('2', 'c')]);
    expect(done.slots).toEqual(['Ah', 'Td', '2c']);
    expect(filledCount(done)).toBe(3);
    expect(activeSlot(done)).toBeNull();
    expect(flopOf(done)).toEqual(['Ah', 'Td', '2c']);
  });

  it('ignores a suit without a rank, and a rank when the flop is full', () => {
    expect(pickerStep(EMPTY_PICKER, { type: 'suit', suit: 's' }).state).toBe(EMPTY_PICKER);
    const full = run([...pick('A', 'h'), ...pick('K', 'h'), ...pick('Q', 'h')]);
    expect(pickerStep(full, { type: 'rank', rank: 'J' }).state).toBe(full);
  });

  it('refuses a card already in the flop and keeps the state', () => {
    const s = run(pick('A', 'h'));
    const withRank = pickerStep(s, { type: 'rank', rank: 'A' }).state;
    const res = pickerStep(withRank, { type: 'suit', suit: 'h' });
    expect(res.error).toBe('duplicate');
    expect(res.state).toBe(withRank);
  });

  it('replaces a tapped filled slot, allowing the same card back', () => {
    const s = run([...pick('A', 'h'), ...pick('K', 'd'), ...pick('2', 'c')]);
    const editing = pickerStep(s, { type: 'edit', slot: 1 }).state;
    expect(editing.editing).toBe(1);
    expect(activeSlot(editing)).toBe(1);
    expect(run(pick('K', 'd'), editing).slots).toEqual(['Ah', 'Kd', '2c']);
    const replaced = run(pick('7', 's'), editing);
    expect(replaced.slots).toEqual(['Ah', '7s', '2c']);
    expect(replaced.editing).toBeNull();
    expect(pickerStep(editing, { type: 'rank', rank: 'A' }).state.pendingRank).toBe('A');
    expect(pickerStep(run([{ type: 'rank', rank: 'A' }], editing), { type: 'suit', suit: 'h' }).error).toBe('duplicate');
  });

  it('tapping an empty slot or the slot being edited leaves edit mode', () => {
    const s = run(pick('A', 'h'));
    expect(pickerStep(s, { type: 'edit', slot: 2 }).state).toBe(s);
    const editing = pickerStep(s, { type: 'edit', slot: 0 }).state;
    expect(pickerStep(editing, { type: 'edit', slot: 0 }).state.editing).toBeNull();
  });

  it('Back cancels the rank, then leaves edit mode, then removes the last card', () => {
    const s = run([...pick('A', 'h'), ...pick('K', 'd')]);
    const pending = pickerStep(s, { type: 'rank', rank: '9' }).state;
    expect(pickerStep(pending, { type: 'back' }).state).toEqual(s);
    const editing = run([{ type: 'edit', slot: 0 }, { type: 'rank', rank: '3' }], s);
    const b1 = pickerStep(editing, { type: 'back' }).state;
    expect(b1).toMatchObject({ pendingRank: null, editing: 0 });
    const b2 = pickerStep(b1, { type: 'back' }).state;
    expect(b2).toMatchObject({ editing: null, slots: ['Ah', 'Kd', null] });
    expect(pickerStep(b2, { type: 'back' }).state.slots).toEqual(['Ah', null, null]);
    expect(pickerStep(EMPTY_PICKER, { type: 'back' }).state).toBe(EMPTY_PICKER);
  });

  it('Clear empties everything', () => {
    const s = run([...pick('A', 'h'), { type: 'rank', rank: 'K' }]);
    expect(pickerStep(s, { type: 'clear' }).state).toEqual(EMPTY_PICKER);
  });
});

describe('full flow (tap cards in and out)', () => {
  it('toggles cards, fills gaps first and caps at three', () => {
    const s = run([{ type: 'toggle', card: 'Ah' }, { type: 'toggle', card: 'Kd' }, { type: 'toggle', card: 'Ah' }]);
    expect(s.slots).toEqual([null, 'Kd', null]);
    const filled = run([{ type: 'toggle', card: '2c' }, { type: 'toggle', card: '3c' }], s);
    expect(filled.slots).toEqual(['2c', 'Kd', '3c']);
    const res = pickerStep(filled, { type: 'toggle', card: '4c' });
    expect(res.error).toBe('full');
    expect(res.state).toBe(filled);
  });
});

describe('prefill from a scan', () => {
  it('keeps valid distinct cards and fills the rest by hand', () => {
    const s = run([{ type: 'rank', rank: 'A' }, { type: 'prefill', cards: ['Kd', 'Kd', 'bad', '9s'] }]);
    expect(s).toEqual({ slots: ['Kd', '9s', null], pendingRank: null, editing: null });
    expect(flopOf(s)).toBeNull();
  });
});
