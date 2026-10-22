import { and, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { auditLog, memberships, users, type MembershipStatus } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import type { Party } from './rules.js';

export type MembershipRow = typeof memberships.$inferSelect;
export type UserRow = typeof users.$inferSelect;

export interface MemberRecord {
  readonly membership: MembershipRow;
  readonly user: UserRow;
}

/** Loads a member of the club (active by default) or throws members.not_found. */
export async function loadMember(
  db: DbOrTx, clubId: string, userId: string, statuses: readonly MembershipStatus[] = ['active'], lock = false,
): Promise<MemberRecord> {
  const q = db.select({ membership: memberships, user: users }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId), inArray(memberships.status, [...statuses])))
    .limit(1);
  const [row] = lock ? await q.for('update', { of: memberships }) : await q;
  if (!row) throw new AppError('members.not_found', 404);
  return row;
}

export const actorParty = (access: ClubAccess): Party => ({ userId: access.user.id, roles: access.roles, isAdmin: access.isAdmin });
export const memberParty = (m: MembershipRow): Party => ({ userId: m.userId, roles: m.roles });

export const nameOf = (u: Pick<UserRow, 'displayName' | 'username'>): string => u.displayName || u.username;

export async function audit(
  db: DbOrTx, entry: { clubId: string; actorId: string; action: string; targetId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    clubId: entry.clubId, actorId: entry.actorId, action: entry.action,
    targetType: entry.targetId ? 'user' : null, targetId: entry.targetId ?? null, data: entry.data ?? null,
  });
}

/** Throws the rule's error code (403) when a rule function returned one. */
export function assertRule(code: string | null): void {
  if (!code) return;
  const status = code === 'members.role_unknown' || code === 'members.play_mode_invalid' ? 400 : 403;
  throw new AppError(code, status);
}
