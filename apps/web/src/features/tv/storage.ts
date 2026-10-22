import type { TvKind } from './types';

/** The paired display token, kept on the TV until it expires. */
export interface StoredDisplay {
  readonly token: string;
  readonly expiresAt: string;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const keyFor = (kind: TvKind): string => `getflop_tv_${kind}`;

function defaultStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveDisplay(kind: TvKind, value: StoredDisplay, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(keyFor(kind), JSON.stringify(value));
  } catch {
    // Storage full or blocked: the TV still works until the page reloads.
  }
}

export function clearDisplay(kind: TvKind, store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(keyFor(kind));
  } catch {
    // Storage blocked: nothing to clear.
  }
}

function parse(raw: string | null): StoredDisplay | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredDisplay>;
    return typeof value.token === 'string' && typeof value.expiresAt === 'string' ? { token: value.token, expiresAt: value.expiresAt } : null;
  } catch {
    return null;
  }
}

/** The stored display if it has not expired; expired or corrupt entries are removed. */
export function loadDisplay(kind: TvKind, now = Date.now(), store: Store | null = defaultStore()): StoredDisplay | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(keyFor(kind)) ?? null;
  } catch {
    return null;
  }
  const value = parse(raw);
  const isLive = value !== null && new Date(value.expiresAt).getTime() > now;
  if (!isLive && raw !== null) clearDisplay(kind, store);
  return isLive ? value : null;
}
