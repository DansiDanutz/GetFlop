import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { memberships, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { requestJoin } from '../clubs/service.js';
import { notify } from './notices.js';
import { verifyPlayerCode } from './playerCode.js';
import { nameOf } from './shared.js';

export type ScanState = 'active' | 'pending' | 'left' | 'removed' | 'none';

function assertScanner(access: ClubAccess): void {
  if (!access.membership || !can(access, 'members.review')) throw new AppError('club.scan_denied', 403);
}

async function resolve(ctx: AppContext, access: ClubAccess, code: string) {
  assertScanner(access);
  const userId = verifyPlayerCode(code, ctx.now());
  const [user] = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || user.deletedAt) throw new AppError('club.scan_code_invalid');
  const [m] = await ctx.db.select().from(memberships)
    .where(and(eq(memberships.clubId, access.club.id), eq(memberships.userId, userId))).limit(1);
  const state: ScanState = m && m.status !== 'rejected' ? m.status : 'none';
  return {
    state,
    player: { id: user.id, displayName: nameOf(user), username: user.username },
    ...(state === 'left' || state === 'removed' ? { endedAt: m?.reviewedAt ?? null } : {}),
  };
}

/** What the desk sees for a scanned player code (03 §6). */
export async function scanCode(ctx: AppContext, access: ClubAccess, code: string) {
  return resolve(ctx, access, code);
}

/** Staff sends a join request on the player's behalf; it still needs normal approval. */
export async function scanRequest(ctx: AppContext, access: ClubAccess, code: string, confirmReturn: boolean) {
  const found = await resolve(ctx, access, code);
  if (found.state === 'active') throw new AppError('club.scan_already_member', 409);
  if (found.state === 'pending') throw new AppError('club.request_pending', 409);
  if ((found.state === 'left' || found.state === 'removed') && !confirmReturn) throw new AppError('club.scan_confirm_return', 409);
  await requestJoin(ctx, found.player.id, access.club.id, 'scan');
  await notify(ctx, { userId: found.player.id, clubId: access.club.id, code: 'club.scan_request', params: { club: access.club.name } });
  return { state: 'pending' as const, player: found.player };
}
