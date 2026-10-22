import { and, count, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubs, clubTables, coupons, memberships, pointAccounts, pointRequests, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { ClubAccess } from '../clubs/access.js';
import { deleteBlockerCounters } from './hooks.js';
import { endMembership } from './lifecycle.js';
import { addNotice, emitNotice, type NoticeInput } from './notices.js';
import { audit } from './shared.js';

/** Days an admin can restore a deleted club (open question in the spec; server parameter). */
export const RESTORE_DAYS = 30;

function assertOwner(access: ClubAccess): void {
  if (!access.roles.includes('owner')) throw new AppError('club.delete_owner_only', 403);
}

const num = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]?.n ?? 0;

async function blockers(ctx: AppContext, clubId: string): Promise<Record<string, number>> {
  const db = ctx.db;
  const [openTables, requests, returns, seatedDealers, liveCoupons] = await Promise.all([
    num(db.select({ n: count() }).from(clubTables).where(and(eq(clubTables.clubId, clubId), eq(clubTables.status, 'open')))),
    num(db.select({ n: count() }).from(pointRequests).where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.status, 'pending'), eq(pointRequests.kind, 'load')))),
    num(db.select({ n: count() }).from(pointRequests).where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.status, 'pending'), eq(pointRequests.kind, 'cashout')))),
    num(db.select({ n: count() }).from(clubTables).where(and(eq(clubTables.clubId, clubId), isNotNull(clubTables.dealerId), ne(clubTables.status, 'archived')))),
    num(db.select({ n: count() }).from(coupons).where(and(eq(coupons.clubId, clubId), eq(coupons.status, 'live')))),
  ]);
  const extra = await Promise.all(deleteBlockerCounters.map((counter) => counter(ctx, clubId)));
  return Object.assign({ openTables, tournaments: 0, requests, returns, seatedDealers, liveCoupons }, ...extra);
}

export async function deleteCheck(ctx: AppContext, access: ClubAccess) {
  assertOwner(access);
  const clubId = access.club.id;
  const [members] = await ctx.db.select({ n: count() }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active')));
  const [wallets] = await ctx.db.select({ total: sql<string>`coalesce(sum(${pointAccounts.balanceCents}), 0)` }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.kind, 'player')));
  return {
    blockers: await blockers(ctx, clubId), members: members?.n ?? 0, pointsCents: Number(wallets?.total ?? 0),
    diamonds: access.club.diamondsBalance, restoreDays: RESTORE_DAYS,
  };
}

/**
 * Owner deletes the club: every other member leaves (wallets back to the pool, where they end
 * with the club), members get the "club deleted" notice, and the club is marked deleted
 * (restorable by a platform admin for RESTORE_DAYS).
 */
export async function deleteClub(ctx: AppContext, access: ClubAccess, input: { confirmName?: string; reason?: string }) {
  assertOwner(access);
  const club = access.club;
  if ((input.confirmName ?? '').trim() !== club.name) throw new AppError('club.delete_name_mismatch', 400, { club: club.name });
  const reason = input.reason?.trim();
  if (!reason) throw new AppError('club.delete_reason_required');
  const found = await blockers(ctx, club.id);
  if (Object.values(found).some((n) => n > 0)) throw new AppError('club.delete_blocked', 409, found);
  const notices: NoticeInput[] = [];
  await ctx.db.transaction(async (tx) => {
    const others = await tx.select().from(memberships)
      .where(and(eq(memberships.clubId, club.id), inArray(memberships.status, ['active', 'pending']), ne(memberships.userId, access.user.id)));
    for (const m of others) {
      await endMembership(tx, { clubId: club.id, membership: m, status: 'removed', actorId: access.user.id, reason: 'club_deleted', now: ctx.now() });
      const notice = { userId: m.userId, clubId: club.id, code: 'club.deleted', params: { club: club.name } };
      await addNotice(tx, notice);
      notices.push(notice);
    }
    const settings = { ...(club.settings as Record<string, unknown>), deletedAt: ctx.now().toISOString(), deletedBy: access.user.id, deleteReason: reason };
    await tx.update(clubs).set({ status: 'deleted', settings }).where(eq(clubs.id, club.id));
    await tx.update(users).set({ activeClubId: null }).where(eq(users.activeClubId, club.id));
    await audit(tx, { clubId: club.id, actorId: access.user.id, action: 'club.deleted', data: { reason, members: others.length } });
  });
  for (const n of notices) {
    ctx.events.emit(rooms.user(n.userId), 'club:membership-changed', { status: 'removed', clubId: club.id, clubName: club.name });
    emitNotice(ctx, n);
  }
  return { deleted: true, restoreDays: RESTORE_DAYS };
}
