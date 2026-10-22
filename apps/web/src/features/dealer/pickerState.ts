/**
 * Flop picker state (pure). Three slots filled rank-then-suit (compact) or by tapping cards (full).
 * Card codes are <rank><suit> with T for ten, suits s h d c.
 */
export const PICKER_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export const PICKER_SUITS = ['s', 'h', 'd', 'c'] as const;
export const FLOP_SIZE = 3;

export type Slot = string | null;
export type Slots = readonly [Slot, Slot, Slot];

export interface PickerState {
  readonly slots: Slots;
  /** Rank chosen for the active slot, waiting for its suit. */
  readonly pendingRank: string | null;
  /** Filled slot being replaced, or null. */
  readonly editing: number | null;
}

export type PickerAction =
  | { readonly type: 'rank'; readonly rank: string }
  | { readonly type: 'suit'; readonly suit: string }
  | { readonly type: 'toggle'; readonly card: string }
  | { readonly type: 'edit'; readonly slot: number }
  | { readonly type: 'back' }
  | { readonly type: 'clear' }
  | { readonly type: 'prefill'; readonly cards: readonly string[] };

export type PickerError = 'duplicate' | 'full';

export interface PickerResult {
  readonly state: PickerState;
  readonly error?: PickerError;
}

export const EMPTY_PICKER: PickerState = { slots: [null, null, null], pendingRank: null, editing: null };

const CARD_RE = /^[AKQJT2-9][shdc]$/;

export function isCardCode(code: string): boolean {
  return CARD_RE.test(code);
}

/** The slot the next card goes into: the one being edited, else the first empty one. */
export function activeSlot(state: PickerState): number | null {
  if (state.editing !== null) return state.editing;
  const i = state.slots.indexOf(null);
  return i < 0 ? null : i;
}

export function filledCount(state: PickerState): number {
  return state.slots.filter((s) => s !== null).length;
}

/** The three cards once complete, else null. */
export function flopOf(state: PickerState): string[] | null {
  return state.slots.every((s) => s !== null) ? (state.slots as readonly string[]).slice() : null;
}

function withSlot(slots: Slots, index: number, value: Slot): Slots {
  return slots.map((s, i) => (i === index ? value : s)) as unknown as Slots;
}

function usedElsewhere(slots: Slots, card: string, except: number | null): boolean {
  return slots.some((s, i) => s === card && i !== except);
}

function chooseSuit(state: PickerState, suit: string): PickerResult {
  const slot = activeSlot(state);
  if (state.pendingRank === null || slot === null) return { state };
  const card = `${state.pendingRank}${suit}`;
  if (usedElsewhere(state.slots, card, slot)) return { state, error: 'duplicate' };
  return { state: { slots: withSlot(state.slots, slot, card), pendingRank: null, editing: null } };
}

function toggle(state: PickerState, card: string): PickerResult {
  const at = state.slots.indexOf(card);
  if (at >= 0) return { state: { ...state, slots: withSlot(state.slots, at, null), editing: null, pendingRank: null } };
  const free = state.slots.indexOf(null);
  if (free < 0) return { state, error: 'full' };
  return { state: { slots: withSlot(state.slots, free, card), pendingRank: null, editing: null } };
}

function edit(state: PickerState, slot: number): PickerResult {
  if (state.editing === slot) return { state: { ...state, editing: null, pendingRank: null } };
  if (state.slots[slot] == null) return { state };
  return { state: { ...state, editing: slot, pendingRank: null } };
}

function back(state: PickerState): PickerResult {
  if (state.pendingRank !== null) return { state: { ...state, pendingRank: null } };
  if (state.editing !== null) return { state: { ...state, editing: null } };
  const last = [...state.slots].map((s, i) => (s === null ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
  if (last < 0) return { state };
  return { state: { ...state, slots: withSlot(state.slots, last, null) } };
}

function prefill(cards: readonly string[]): PickerResult {
  const clean = cards.filter(isCardCode).filter((c, i, all) => all.indexOf(c) === i).slice(0, FLOP_SIZE);
  const slots = [0, 1, 2].map((i) => clean[i] ?? null) as unknown as Slots;
  return { state: { slots, pendingRank: null, editing: null } };
}

export function pickerStep(state: PickerState, action: PickerAction): PickerResult {
  switch (action.type) {
    case 'rank':
      return activeSlot(state) === null ? { state } : { state: { ...state, pendingRank: action.rank } };
    case 'suit':
      return chooseSuit(state, action.suit);
    case 'toggle':
      return toggle(state, action.card);
    case 'edit':
      return edit(state, action.slot);
    case 'back':
      return back(state);
    case 'clear':
      return { state: EMPTY_PICKER };
    case 'prefill':
      return prefill(action.cards);
  }
}
