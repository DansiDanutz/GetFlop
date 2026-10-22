/** Pairing code entry on the TV: 6 digits, typed on a keyboard, a remote or the on-screen keypad. */
export const CODE_LENGTH = 6;

export function pushDigit(code: string, digit: string): string {
  if (!/^\d$/.test(digit) || code.length >= CODE_LENGTH) return code;
  return `${code}${digit}`;
}

export function popDigit(code: string): string {
  return code.slice(0, -1);
}

export function isComplete(code: string): boolean {
  return code.length === CODE_LENGTH && /^\d+$/.test(code);
}

/** "123456" → "123 456" (how the staff phone shows it). */
export function formatCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export type KeyAction =
  | { readonly type: 'digit'; readonly digit: string }
  | { readonly type: 'back' }
  | { readonly type: 'clear' }
  | { readonly type: 'submit' };

/** Maps a keyboard / remote key to an action (numpad keys report their digit as `key`). */
export function keyToAction(key: string): KeyAction | null {
  if (/^\d$/.test(key)) return { type: 'digit', digit: key };
  if (key === 'Backspace' || key === 'Delete') return { type: 'back' };
  if (key === 'Escape') return { type: 'clear' };
  if (key === 'Enter') return { type: 'submit' };
  return null;
}

export function applyKey(code: string, action: KeyAction): string {
  switch (action.type) {
    case 'digit': return pushDigit(code, action.digit);
    case 'back': return popDigit(code);
    case 'clear': return '';
    default: return code;
  }
}
