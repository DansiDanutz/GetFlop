import { and, count, eq, inArray, ne } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import {
  auditLog, clubTables, clubs, coupons, memberships, pointRequests, users,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { membershipGuards } from '../members/hooks.js';
import { balanceOf, move, POOL, stock, wallet, type AccountRef } from '../points/ledger.js';
import { hashSecret, newToken, verifySecret } from './crypto.js';
import { announceEnded, revokeSessions } from './revocation.js';
import type { AuthUser } from './session.js';

const ENDED_MEMBERSHIPS = ['active', 'pending'] as const;
export const DELETED_REASON = 'account_deleted';

/** Every refusal happens before anything changes (spec 02 §10, 03 leave blockers). */
async function assertDeletable(ctx: AppContext, user: AuthUser, pin: string): Promise<void> {
  if (user.isPlatformAdmin) throw new AppError('account.platform_admin', 403);
  if (!(await verifySecret(pin, user.pinHash))) throw new AppError('account.pin_wrong', 403);
  const owned = await ctx.db.select({ id: clubs.id, name: clubs.name }).from(clubs)
    .where(and(eq(clubs.ownerId, user.id), ne(clubs.status, 'deleted')));
  for (const club of owned) {
    const [others] = await ctx.db.select({ n: count() }).from(memberships).where(and(
      eq(memberships.clubId, club.id), eq(memberships.status, 'active'), ne(memberships.userId, user.id),
    ));
    if ((others?.n ?? 0) > 0) throw new AppError('account.last_owner', 409, { club: club.name });
  }
  const [live] = await ctx.db.select({ n: count() }).from(coupons).where(and(eq(coupons.userId, user.id), eq(coupons.status, 'live')));
  if ((live?.n ?? 0) > 0) throw new AppError('club.leave_live_coupons', 409, { count: live!.n });
  const [dealing] = await ctx.db.select({ name: clubTables.name }).from(clubTables)
    .where(and(eq(clubTables.dealerId, user.id), ne(clubTables.status, 'archived'))).limit(1);
  if (dealing) throw new AppError('club.leave_dealing', 409, { table: dealing.name });
}

/** Moves a wallet or inspector stock back to the club pool (ledger membership_ended). */
async function returnToPool(tx: Tx, clubId: string, userId: string, from: AccountRef): Promise<number> {
  const held = await balanceOf(tx, clubId, from);
  if (held <= 0) return 0;
  await move(tx, { clubId, kind: 'membership_ended', from, to: POOL, amountCents: held, actorId: userId, userId, note: DELETED_REASON });
  return held;
}

async function endMemberships(ctx: AppContext, tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.select({ clubId: memberships.clubId, status: memberships.status }).from(memberships)
    .where(and(eq(memberships.userId, userId), inArray(memberships.status, [...ENDED_MEMBERSHIPS])));
  const activeClubs = rows.filter((r) => r.status === 'active').map((r) => r.clubId);
  for (const clubId of activeClubs) {
    // Other modules' leave blockers (e.g. tournament entries) throw and roll everything back.
    for (const guard of membershipGuards) await guard(ctx, tx, { clubId, userId, reason: 'leave' });
    await returnToPool(tx, clubId, userId, wallet(userId));
    await returnToPool(tx, clubId, userId, stock(userId));
  }
  await tx.update(memberships).set({ status: 'left', roles: [], reviewedAt: ctx.now() })
    .where(and(eq(memberships.userId, userId), inArray(memberships.status, [...ENDED_MEMBERSHIPS])));
  await tx.update(pointRequests).set({ status: 'rejected', rejectionReason: DELETED_REASON, reviewedAt: ctx.now() })
    .where(and(eq(pointRequests.userId, userId), eq(pointRequests.status, 'pending')));
  return activeClubs;
}

/** A club whose only member was its owner closes with the account. */
async function closeOwnedClubs(tx: Tx, userId: string): Promise<string[]> {
  const closed = await tx.update(clubs).set({ status: 'deleted' })
    .where(and(eq(clubs.ownerId, userId), ne(clubs.status, 'deleted'))).returning({ id: clubs.id });
  const ids = closed.map((c) => c.id);
  if (ids.length > 0) {
    await tx.update(clubTables).set({ status: 'closed', dealerId: null })
      .where(and(inArray(clubTables.clubId, ids), eq(clubTables.status, 'open')));
  }
  return ids;
}

/** Removes personal identifiers; club records keep the (now anonymous) user id. */
async function anonymize(ctx: AppContext, tx: Tx, user: AuthUser): Promise<void> {
  await tx.update(users).set({
    username: `deleted_${user.id.replace(/-/g, '')}`,
    displayName: null, email: null, emailVerifiedAt: null, googleSub: null, googleEmail: null,
    pinHash: await hashSecret(newToken()), marketingConsent: false, isActive: false, activeClubId: null,
    playerCode: newToken().slice(0, 16), deletedAt: ctx.now(),
  }).where(eq(users.id, user.id));
}

/** POST /auth/delete-account: irreversible. */
export async function deleteAccount(ctx: AppContext, user: AuthUser, pin: string): Promise<void> {
  await assertDeletable(ctx, user, pin);
  const touched = await ctx.db.transaction(async (tx) => {
    const left = await endMemberships(ctx, tx, user.id);
    const closed = await closeOwnedClubs(tx, user.id);
    await anonymize(ctx, tx, user);
    await revokeSessions(tx, user.id, { reason: DELETED_REASON });
    await tx.insert(auditLog).values({
      actorId: user.id, action: 'account.deleted', targetType: 'user', targetId: user.id,
      data: { clubsLeft: left, clubsClosed: closed },
    });
    return left;
  });
  announceEnded(ctx, user.id, DELETED_REASON);
  for (const clubId of touched) {
    ctx.events.emit(rooms.staff(clubId), 'live:changed', { clubId, kind: 'points' });
    ctx.events.emit(rooms.staff(clubId), 'floor:changed', {});
  }
}
