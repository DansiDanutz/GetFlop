import { readTableJoin } from '../me/storage';
import type { User } from '../../state/session';

/**
 * Where to go after signing in: a pending table QR join first, then an admin's console,
 * then the page that asked for sign-in, else the clubs home (which shows a pending invite banner).
 */
export function afterSignInPath(user: Pick<User, 'role'>, from?: string | null): string {
  const join = readTableJoin();
  if (join) return `/join/${encodeURIComponent(join.code)}`;
  if (user.role === 'admin') return '/admin';
  if (from && from !== '/login' && !from.startsWith('/register')) return from;
  return '/clubs';
}
