import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubs, memberships, type Role } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { ClubAccess } from '../clubs/access.js';
import { balanceOf, move, POOL, stock } from '../points/ledger.js';
import { nextRoles, playModeError, roleChangeError, type RoleChange } from './rules.js';
import { actorParty, assertRule, audit, loadMember, memberParty } from './shared.js';

export const PLAY_MODES = ['play', 'watch'] as const;
export type PlayMode = (typeof PLAY_MODES)[number];

function contextChanged(ctx: AppContext, clubId: string, userId: string): void {
  ctx.events.emit(rooms.user(userId), 'club:context-changed', { clubId });
  ctx.events.emit(rooms.staff(clubId), 'members:changed', { clubId, userId });
}

/** Grants or revokes one role (00 §3.3). Idempotent: granting a held role changes nothing. */
export async function changeRole(ctx: AppContext, access: ClubAccess, userId: string, role: string, change: RoleChange) {
  const clubId = access.club.id;
  const roles = await ctx.db.transaction(async (tx) => {
    const target = await loadMember(tx, clubId, userId, ['active'], true);
    assertRule(roleChangeError(actorParty(access), memberParty(target.membership), role, change));
    const updated = nextRoles(target.membership.roles, role as Role, change);
    if (updated.join() === target.membership.roles.join()) return updated;
    await tx.update(memberships).set({ roles: updated }).where(eq(memberships.id, target.membership.id));
    await audit(tx, {
      clubId, actorId: access.user.id, targetId: userId,
      action: change === 'grant' ? 'members.role_granted' : 'members.role_revoked', data: { role },
    });
    return updated;
  });
  contextChanged(ctx, clubId, userId);
  return { userId, roles };
}

export async function setPlayMode(ctx: AppContext, access: ClubAccess, userId: string, mode: string) {
  if (!(PLAY_MODES as readonly string[]).includes(mode)) throw new AppError('members.play_mode_invalid');
  const clubId = access.club.id;
  await ctx.db.transaction(async (tx) => {
    const target = await loadMember(tx, clubId, userId, ['active'], true);
    assertRule(playModeError(actorParty(access), memberParty(target.membership)));
    if (target.membership.playMode === mode) return;
    await tx.update(memberships).set({ playMode: mode }).where(eq(memberships.id, target.membership.id));
    await audit(tx, { clubId, actorId: access.user.id, targetId: userId, action: 'members.play_mode', data: { mode } });
  });
  contextChanged(ctx, clubId, userId);
  return { userId, playMode: mode as PlayMode };
}

/**
 * Owner hands the club to another active member. The new owner keeps a dealer role if held;
 * the previous owner becomes manager (keeping dealer). Any inspector stock of the new owner returns to the pool.
 */
export async function transferOwnership(ctx: AppContext, access: ClubAccess, newOwnerId: string) {
  if (!access.roles.includes('owner')) throw new AppError('members.owner_only', 403);
  const clubId = access.club.id;
  const oldOwnerId = access.user.id;
  if (newOwnerId === oldOwnerId) throw new AppError('members.owner_self');
  await ctx.db.transaction(async (tx) => {
    const heir = await loadMember(tx, clubId, newOwnerId, ['active'], true);
    const [current] = await tx.select().from(memberships)
      .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, oldOwnerId), eq(memberships.status, 'active'))).for('update');
    if (!current?.roles.includes('owner')) throw new AppError('members.owner_state', 500);
    const keepDealer = (roles: readonly Role[]): Role[] => (roles.includes('dealer') ? ['dealer'] : []);
    await tx.update(memberships).set({ roles: ['owner', ...keepDealer(heir.membership.roles)] }).where(eq(memberships.id, heir.membership.id));
    await tx.update(memberships).set({ roles: ['manager', ...keepDealer(current.roles)] }).where(eq(memberships.id, current.id));
    await tx.update(clubs).set({ ownerId: newOwnerId }).where(eq(clubs.id, clubId));
    const held = await balanceOf(tx, clubId, stock(newOwnerId));
    if (held > 0) {
      await move(tx, { clubId, kind: 'stock_take', from: stock(newOwnerId), to: POOL, amountCents: held, actorId: oldOwnerId, note: 'ownership_transfer' });
    }
    await audit(tx, { clubId, actorId: oldOwnerId, targetId: newOwnerId, action: 'members.owner_transferred' });
  });
  contextChanged(ctx, clubId, newOwnerId);
  contextChanged(ctx, clubId, oldOwnerId);
  return { ownerId: newOwnerId };
}
