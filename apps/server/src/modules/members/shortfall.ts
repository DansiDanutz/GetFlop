import { eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { notify } from './notices.js';

const SHORT_CODES = new Set(['points.pool_short', 'points.stock_short']);

/**
 * When a Send Out, stock give or request approval by staff fails for lack of Points,
 * the owner gets a notice (04 §4): notice_points_pool_short / notice_points_stock_short
 * with {staff, tried, club, have} in Points. The owner's own shortfalls are not reported.
 */
export async function reportShortfall(ctx: AppContext, access: ClubAccess, err: unknown, triedCents: number): Promise<void> {
  if (!(err instanceof AppError) || !SHORT_CODES.has(err.code)) return;
  const ownerId = access.club.ownerId;
  if (ownerId === access.user.id) return;
  try {
    const [actor] = await ctx.db.select({ username: users.username, displayName: users.displayName }).from(users)
      .where(eq(users.id, access.user.id)).limit(1);
    const have = Number(err.params.balance ?? err.params.stock ?? err.params.pool ?? 0);
    await notify(ctx, {
      userId: ownerId, clubId: access.club.id, code: err.code,
      params: { staff: actor?.displayName || actor?.username || '', tried: triedCents / 100, club: access.club.name, have: have / 100 },
    });
  } catch (notifyErr) {
    ctx.logger.error('Could not notify the owner of a Points shortfall', notifyErr);
  }
}

/** Runs a Points action and reports a shortfall to the owner before rethrowing. */
export async function withShortfallNotice<T>(ctx: AppContext, access: ClubAccess, triedCents: number, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    await reportShortfall(ctx, access, err, triedCents);
    throw err;
  }
}
