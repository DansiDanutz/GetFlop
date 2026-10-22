import { describe, expect, it } from 'vitest';
import { applyKey, formatCode, isComplete, keyToAction, popDigit, pushDigit } from './codeInput';
import { clockOffset, mmss, secondsUntil, toLocal } from './clock';
import { clearDisplay, loadDisplay, saveDisplay } from './storage';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    data,
  };
}

describe('code input', () => {
  it('accepts up to six digits and ignores anything else', () => {
    const typed = ['1', 'a', '2', '3', '4', '5', '6', '7'].reduce(pushDigit, '');
    expect(typed).toBe('123456');
    expect(isComplete(typed)).toBe(true);
    expect(isComplete('12345')).toBe(false);
  });

  it('formats the code in two groups', () => {
    expect(formatCode('123456')).toBe('123 456');
    expect(formatCode('12')).toBe('12');
  });

  it('maps keyboard and remote keys', () => {
    expect(keyToAction('7')).toEqual({ type: 'digit', digit: '7' });
    expect(keyToAction('Backspace')).toEqual({ type: 'back' });
    expect(keyToAction('Escape')).toEqual({ type: 'clear' });
    expect(keyToAction('Enter')).toEqual({ type: 'submit' });
    expect(keyToAction('x')).toBeNull();
    expect(applyKey('12', { type: 'back' })).toBe('1');
    expect(applyKey('12', { type: 'clear' })).toBe('');
    expect(applyKey('12', { type: 'digit', digit: '3' })).toBe('123');
    expect(applyKey('12', { type: 'submit' })).toBe('12');
    expect(popDigit('')).toBe('');
  });
});

describe('display storage', () => {
  it('keeps the token until it expires', () => {
    const store = memoryStore();
    saveDisplay('cash', { token: 'tok', expiresAt: '2026-09-25T18:00:00Z' }, store);
    expect(loadDisplay('cash', Date.parse('2026-09-25T17:59:00Z'), store)).toEqual({ token: 'tok', expiresAt: '2026-09-25T18:00:00Z' });
    expect(loadDisplay('tournament', Date.parse('2026-09-25T17:59:00Z'), store)).toBeNull();
    expect(loadDisplay('cash', Date.parse('2026-09-25T18:00:01Z'), store)).toBeNull();
    expect(store.data.size).toBe(0);
  });

  it('drops corrupt entries and clears on demand', () => {
    const store = memoryStore();
    store.setItem('getflop_tv_cash', '{oops');
    expect(loadDisplay('cash', 0, store)).toBeNull();
    expect(store.data.size).toBe(0);
    saveDisplay('cash', { token: 't', expiresAt: '2030-01-01T00:00:00Z' }, store);
    clearDisplay('cash', store);
    expect(loadDisplay('cash', 0, store)).toBeNull();
  });

  it('survives a missing store', () => {
    expect(loadDisplay('cash', 0, null)).toBeNull();
    expect(() => saveDisplay('cash', { token: 't', expiresAt: 'x' }, null)).not.toThrow();
  });
});

describe('clock', () => {
  it('corrects server times for a TV clock that is off', () => {
    const offset = clockOffset('2026-09-24T18:00:10Z', Date.parse('2026-09-24T18:00:00Z'));
    expect(offset).toBe(10_000);
    expect(toLocal('2026-09-24T18:00:40Z', offset)?.toISOString()).toBe('2026-09-24T18:00:30.000Z');
    expect(toLocal(null, offset)).toBeNull();
    expect(clockOffset('garbage', 0)).toBe(0);
  });

  it('counts seconds and formats m:ss', () => {
    expect(secondsUntil(new Date(10_500), 0)).toBe(11);
    expect(secondsUntil(new Date(0), 5_000)).toBe(0);
    expect(secondsUntil(null)).toBe(0);
    expect(mmss(605)).toBe('10:05');
    expect(mmss(-3)).toBe('0:00');
  });
});
