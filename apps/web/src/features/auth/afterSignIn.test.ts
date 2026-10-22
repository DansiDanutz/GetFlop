import { beforeEach, describe, expect, it, vi } from 'vitest';
import { afterSignInPath } from './afterSignIn';

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

beforeEach(() => { vi.stubGlobal('sessionStorage', memoryStorage()); vi.stubGlobal('localStorage', memoryStorage()); });

describe('afterSignInPath', () => {
  it('sends admins to the console and players home or back where they were', () => {
    expect(afterSignInPath({ role: 'admin' })).toBe('/admin');
    expect(afterSignInPath({ role: 'player' })).toBe('/clubs');
    expect(afterSignInPath({ role: 'player' }, '/account')).toBe('/account');
    expect(afterSignInPath({ role: 'player' }, '/login')).toBe('/clubs');
    expect(afterSignInPath({ role: 'player' }, '/register/google')).toBe('/clubs');
  });

  it('continues a pending table QR join first', () => {
    sessionStorage.setItem('getflop_pending_table_join', JSON.stringify({ code: 'AB12CD34', tableId: 't', tableName: 'T', clubId: 'c', clubName: 'C' }));
    expect(afterSignInPath({ role: 'player' }, '/account')).toBe('/join/AB12CD34');
  });
});
