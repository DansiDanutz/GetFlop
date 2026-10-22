import { and, count, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Tx } from '../../db/client.js';
import { clubTables, coupons, memberships, pointRequests, users, type MembershipStatus } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { ClubAccess } from '../clubs/access.js';
import { balanceOf, move, POOL, stock, wallet } from '../points/ledger.js';
import { membershipGuards } from './hooks.js';
import { addNotice, emitNotice } from './notices.js';
import { removeError } from './rules.js';
import { actorParty, assertRule, audit, loadMember, type MembershipRow } from './shared.js';

const REASON_MAX = 200;

export const cleanReason = (reason: string | undefined): string | null => {
  const text = reason?.trim() || null;
  return text ? text.slice(0, REASON_MAX) : null;
};

interface EndInput {
  readonly clubId: string;
  readonly membership: MembershipRow;
  readonly status: Extract<MembershipStatus, 'left' | 'removed'>;
  readonly actorId: string;
  readonly reason: string | null;
  readonly now: Date;
}

/**
 * Ends one membership inside a transaction: the wallet balance and any inspector stock go
 * back to the pool (ledger membership_ended / stock_take), waiting Points requests are
 * declined, and the member loses every role. Returns the Points returned from the wallet.
 */
export async function endMembership(tx: Tx, input: EndInput): Promise<number> {
  const { clubId, membership, actorId } = input;
  const userId = membership.userId;
  const balance = await balanceOf(tx, clubId, wallet(userId));
  if (balance > 0) {
    await move(tx, { clubId, kind: 'membership_ended', from: wallet(userId), to: POOL, amountCents: balance, actorId, userId, note: input.reason });
  }
  const held = await balanceOf(tx, clubId, stock(userId));
  if (held > 0) {
    await move(tx, { clubId, kind: 'stock_take', from: stock(userId), to: POOL, amountCents: held, actorId, note: 'membership_ended' });
  }
  await tx.update(pointRequests)
    .set({ status: 'rejected', reviewedBy: actorId, reviewedAt: input.now, rejectionReason: 'membership_ended' })
    .where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.userId, userId), eq(pointRequests.status, 'pending')));
  await tx.update(memberships).set({
    status: input.status, roles: [], reviewedBy: actorId, reviewedAt: input.now, rejectionReason: input.reason,
  }).where(eq(memberships.id, membership.id));
  await tx.update(users).set({ activeClubId: null }).where(and(eq(users.id, userId), eq(users.activeClubId, clubId)));
  return balance;
}

/** The table this member is dealing in this club, if any. */
async function dealingTable(tx: Tx, clubId: string, userId: string) {
  const [table] = await tx.select({ name: clubTables.name }).from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.dealerId, userId), inArray(clubTables.status, ['open', 'closed']))).limit(1);
  return table ?? null;
}

async function assertNotDealing(tx: Tx, clubId: string, userId: string): Promise<void> {
  const table = await dealingTable(tx, clubId, userId);
  if (table) throw new AppError('club.leave_dealing', 409, { table: table.name });
}

function afterEnd(ctx: AppContext, access: ClubAccess, userId: string, status: 'left' | 'removed'): void {
  const clubId = access.club.id;
  ctx.events.emit(rooms.user(userId), 'club:membership-changed', { status, clubId, clubName: access.club.name });
  ctx.events.emit(rooms.user(userId), 'balance:updated', { clubId, balanceCents: 0 });
  ctx.events.emit(rooms.staff(clubId), 'members:changed', { clubId, userId });
  ctx.events.emit(rooms.staff(clubId), 'live:changed', { clubId, kind: 'points' });
}

/** Staff removes a member (00 §3.3). The balance returns to the pool; the member may ask to join again. */
export async function removeMember(ctx: AppContext, access: ClubAccess, userId: string, reason?: string) {
  const clubId = access.club.id;
  const note = cleanReason(reason);
  const notice = { userId, clubId, code: 'club.removed', params: { club: access.club.name } };
  const returnedCents = await ctx.db.transaction(async (tx) => {
    const target = await loadMember(tx, clubId, userId, ['active'], true);
    assertRule(removeError(actorParty(access), { userId, roles: target.membership.roles }));
    await assertNotDealing(tx, clubId, userId);
    for (const guard of membershipGuards) await guard(ctx, tx, { clubId, userId, reason: 'remove' });
    const returned = await endMembership(tx, { clubId, membership: target.membership, status: 'removed', actorId: access.user.id, reason: note, now: ctx.now() });
    await audit(tx, { clubId, actorId: access.user.id, targetId: userId, action: 'members.removed', data: { returnedCents: returned, reason: note } });
    await addNotice(tx, notice);
    return returned;
  });
  afterEnd(ctx, access, userId, 'removed');
  emitNotice(ctx, notice);
  return { returnedCents };
}

/** A member leaves on their own. Blockers: owner, live coupons, tournaments (hooks), dealing. */
export async function leaveClub(ctx: AppContext, access: ClubAccess, reason?: string) {
  if (!access.membership) throw new AppError('club.access_denied', 403);
  if (access.roles.includes('owner')) throw new AppError('club.leave_last_owner', 409);
  const clubId = access.club.id;
  const userId = access.user.id;
  const note = cleanReason(reason);
  const returnedCents = await ctx.db.transaction(async (tx) => {
    const me = await loadMember(tx, clubId, userId, ['active'], true);
    const [live] = await tx.select({ n: count() }).from(coupons)
      .where(and(eq(coupons.clubId, clubId), eq(coupons.userId, userId), eq(coupons.status, 'live')));
    if ((live?.n ?? 0) > 0) throw new AppError('club.leave_live_coupons', 409, { count: live!.n });
    for (const guard of membershipGuards) await guard(ctx, tx, { clubId, userId, reason: 'leave' });
    await assertNotDealing(tx, clubId, userId);
    const returned = await endMembership(tx, { clubId, membership: me.membership, status: 'left', actorId: userId, reason: note, now: ctx.now() });
    await audit(tx, { clubId, actorId: userId, targetId: userId, action: 'members.left', data: { returnedCents: returned, reason: note } });
    return returned;
  });
  afterEnd(ctx, access, userId, 'left');
  return { returnedCents };
}
