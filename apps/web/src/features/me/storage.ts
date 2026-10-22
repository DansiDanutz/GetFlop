/**
 * Small per-device stores: pending club invite, pending table join, welcome seen,
 * install prompt dismissed. Storage can be unavailable (private mode): every access is guarded.
 */

export const KEYS = {
  invite: 'getflop_pending_invite',
  tableJoin: 'getflop_pending_table_join',
  welcomeSeen: 'getflop_welcome_seen',
  installDismissed: 'getflop_install_dismissed',
} as const;

const INVITE_TTL_MS = 7 * 86_400_000;
const PUBLIC_ID_RE = /^\d{7}$/;
const JOIN_CODE_RE = /^[A-Za-z0-9]{4,16}$/;

type Area = 'local' | 'session';

function store(area: Area): Storage | null {
  try {
    return area === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readJson<T>(area: Area, key: string): T | null {
  try {
    const raw = store(area)?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(area: Area, key: string, value: unknown): void {
  try { store(area)?.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

export function remove(area: Area, key: string): void {
  try { store(area)?.removeItem(key); } catch { /* storage blocked */ }
}

// ── Club invite (#/c/<publicId>) ──

export interface PendingInvite { readonly publicId: string; readonly storedAt: number }

export const isPublicId = (value: string): boolean => PUBLIC_ID_RE.test(value);
export const isJoinCode = (value: string): boolean => JOIN_CODE_RE.test(value);

export function storeInvite(publicId: string, now = Date.now()): boolean {
  if (!isPublicId(publicId)) return false;
  writeJson('local', KEYS.invite, { publicId, storedAt: now } satisfies PendingInvite);
  return true;
}

/** The stored invite, unless it is malformed or older than a week. */
export function readInvite(now = Date.now()): PendingInvite | null {
  const invite = readJson<PendingInvite>('local', KEYS.invite);
  if (!invite || !isPublicId(invite.publicId) || now - invite.storedAt > INVITE_TTL_MS) return null;
  return invite;
}

export const clearInvite = (): void => remove('local', KEYS.invite);

// ── Table join (#/join/<code>) ──

export interface PendingTableJoin {
  readonly code: string;
  readonly tableId: string;
  readonly tableName: string;
  readonly clubId: string;
  readonly clubName: string;
}

export function storeTableJoin(join: PendingTableJoin): void {
  if (isJoinCode(join.code)) writeJson('session', KEYS.tableJoin, join);
}

export function readTableJoin(): PendingTableJoin | null {
  const join = readJson<PendingTableJoin>('session', KEYS.tableJoin);
  return join && isJoinCode(join.code) ? join : null;
}

export const clearTableJoin = (): void => remove('session', KEYS.tableJoin);

// ── Flags ──

export const readFlag = (key: string): boolean => readJson<boolean>('local', key) === true;
export const setFlag = (key: string, on: boolean): void => (on ? writeJson('local', key, true) : remove('local', key));
