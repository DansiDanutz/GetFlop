import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEYS, clearInvite, clearTableJoin, readFlag, readInvite, readTableJoin, setFlag, storeInvite, storeTableJoin,
} from './storage';

/** Node 26 ships its own (file-less, undefined) localStorage that hides jsdom's; use a memory Storage. */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, String(v)); },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
});

describe('pending invite', () => {
  it('stores a 7-digit Club ID and forgets it after a week', () => {
    const now = Date.UTC(2026, 8, 24);
    expect(storeInvite('1234567', now)).toBe(true);
    expect(readInvite(now + 1_000)).toEqual({ publicId: '1234567', storedAt: now });
    expect(readInvite(now + 8 * 86_400_000)).toBeNull();
    clearInvite();
    expect(readInvite(now)).toBeNull();
  });

  it('refuses malformed ids and tampered storage', () => {
    expect(storeInvite('12ab567')).toBe(false);
    expect(readInvite()).toBeNull();
    localStorage.setItem(KEYS.invite, '{not json');
    expect(readInvite()).toBeNull();
    localStorage.setItem(KEYS.invite, JSON.stringify({ publicId: '<x>', storedAt: Date.now() }));
    expect(readInvite()).toBeNull();
  });
});

describe('pending table join', () => {
  const join = { code: 'AB12CD34', tableId: 't1', tableName: 'Table 1', clubId: 'c1', clubName: 'Sharks' };

  it('lives in session storage', () => {
    storeTableJoin(join);
    expect(readTableJoin()).toEqual(join);
    expect(localStorage.getItem(KEYS.tableJoin)).toBeNull();
    clearTableJoin();
    expect(readTableJoin()).toBeNull();
  });

  it('ignores invalid codes', () => {
    storeTableJoin({ ...join, code: 'x' });
    expect(readTableJoin()).toBeNull();
  });
});

describe('device flags', () => {
  it('sets and clears', () => {
    expect(readFlag(KEYS.welcomeSeen)).toBe(false);
    setFlag(KEYS.welcomeSeen, true);
    expect(readFlag(KEYS.welcomeSeen)).toBe(true);
    setFlag(KEYS.welcomeSeen, false);
    expect(readFlag(KEYS.welcomeSeen)).toBe(false);
  });
});
