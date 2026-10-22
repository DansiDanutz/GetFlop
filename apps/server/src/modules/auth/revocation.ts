import { and, eq, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { sessionRevocations, sessions } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';
import { createSession, type AuthUser } from './session.js';

export type EndReason = 'other_device' | 'pin_change' | 'pin_reset' | 'account_deleted';

export interface RevokeOptions {
  readonly reason: EndReason;
  readonly deviceLabel?: string | null;
  /** sessions.id (token hash) to keep, e.g. the device that changed the PIN. */
  readonly keepSessionId?: string;
}

/** Device family from a User-Agent, used to name "the other device". */
export function deviceLabel(ua: string | undefined): string {
  if (!ua) return 'other';
  if (/iPad/.test(ua)) return 'ipad';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

/**
 * Ends a user's sessions and remembers why, so a revoked device gets
 * `auth.session_ended {reason, deviceLabel}` instead of a bare 401. Returns how many ended.
 */
export async function revokeSessions(db: DbOrTx, userId: string, opts: RevokeOptions): Promise<number> {
  const where = opts.keepSessionId
    ? and(eq(sessions.userId, userId), ne(sessions.id, opts.keepSessionId))
    : eq(sessions.userId, userId);
  const ended = await db.delete(sessions).where(where).returning({ id: sessions.id });
  if (ended.length === 0) return 0;
  await db.insert(sessionRevocations)
    .values(ended.map((s) => ({ id: s.id, userId, reason: opts.reason, deviceLabel: opts.deviceLabel ?? null })))
    .onConflictDoNothing();
  return ended.length;
}

/** Tells the user's sockets that sessions ended (clients re-check /auth/me before signing out). */
export function announceEnded(ctx: AppContext, userId: string, reason: EndReason, label?: string | null): void {
  ctx.events.emit(rooms.user(userId), 'session:ended', label ? { reason, deviceLabel: label } : { reason });
}

/** Signs in: one device at a time, so every other session is revoked and told. */
export async function startSession(ctx: AppContext, user: AuthUser, userAgent: string | undefined): Promise<string> {
  const label = deviceLabel(userAgent);
  const ended = await revokeSessions(ctx.db, user.id, { reason: 'other_device', deviceLabel: label });
  if (ended > 0) announceEnded(ctx, user.id, 'other_device', label);
  return createSession(ctx, user.id, userAgent);
}
