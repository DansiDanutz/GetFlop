import { and, count, eq, gte, lt, ne, or, isNull, isNotNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { clubMessages } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { levelOf, nextLevel } from '../commerce/levels.js';
import { FREE_MESSAGING_UNTIL, MEMBER_AUDIENCE } from './constants.js';
import { startOfMonth, startOfNextMonth } from './time.js';

/** Quotas are counted per calendar month in Greek time (the platform's billing zone). */
const QUOTA_TZ = 'Europe/Athens';

/**
 * Monthly promotional-broadcast quota for a Level, or null for unlimited.
 * The default catalogue does not define broadcast quotas yet (spec open question 3): a Level
 * without a numeric `broadcasts` entitlement stays unlimited even after the free period.
 */
export function broadcastQuota(levelCode: string, at: Date): number | null {
  if (at < FREE_MESSAGING_UNTIL) return null;
  const limit = (levelOf(levelCode) as { broadcasts?: unknown }).broadcasts;
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

/** Group messages sent or waiting to go out in the month of `at` (direct messages are not promotional). */
async function broadcastsInMonth(db: DbOrTx, clubId: string, at: Date): Promise<number> {
  const from = startOfMonth(at, QUOTA_TZ);
  const to = startOfNextMonth(at, QUOTA_TZ);
  const [row] = await db.select({ n: count() }).from(clubMessages).where(and(
    eq(clubMessages.clubId, clubId), ne(clubMessages.audience, MEMBER_AUDIENCE),
    or(eq(clubMessages.status, 'sent'), eq(clubMessages.status, 'scheduled')),
    or(
      and(isNotNull(clubMessages.sendAt), gte(clubMessages.sendAt, from), lt(clubMessages.sendAt, to)),
      and(isNull(clubMessages.sendAt), gte(clubMessages.createdAt, from), lt(clubMessages.createdAt, to)),
    ),
  ));
  return row?.n ?? 0;
}

/** Throws commerce.capacity_broadcasts_* when a new group message at `at` would exceed the Level quota. */
export async function assertBroadcastQuota(db: DbOrTx, access: ClubAccess, at: Date): Promise<void> {
  const limit = broadcastQuota(access.club.level, at);
  if (limit === null) return;
  const used = await broadcastsInMonth(db, access.club.id, at);
  if (used < limit) return;
  const variant = access.roles.includes('owner') ? 'billing' : 'staff';
  throw new AppError(`commerce.capacity_broadcasts_${variant}`, 409, {
    used, limit, nextLevel: nextLevel(access.club.level)?.name ?? '',
    resetDate: new Intl.DateTimeFormat('en-CA', { timeZone: QUOTA_TZ }).format(startOfNextMonth(at, QUOTA_TZ)),
  });
}
