import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { memberships, pointRequests, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { balanceOf, move, POOL, stock, wallet, type AccountRef } from './ledger.js';

export const NOTE_MAX = 200;

/** Parses a Points amount typed by a person: > 0, at most 2 decimals. Returns cents. */
export function parseAmount(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new AppError('points.amount_invalid');
  const cents = Math.round(Number(text) * 100);
  if (cents <= 0) throw new AppError('points.amount_invalid');
  return cents;
}

function assertNote(note: string | undefined): string | null {
  const text = note?.trim() || null;
  if (text && text.length > NOTE_MAX) throw new AppError('points.note_too_long', 400, { n: NOTE_MAX });
  return text;
}

/** Owner and manager send from the pool; an inspector from their own stock. */
export function staffSource(access: ClubAccess): AccountRef {
  return access.rank >= 3 || access.isAdmin ? POOL : stock(access.user.id);
}

async function assertMember(ctx: AppContext, clubId: string, userId: string): Promise<void> {
  const [m] = await ctx.db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId), eq(memberships.status, 'active'))).limit(1);
  if (!m) throw new AppError('members.not_found', 404);
}

function notifyBalance(ctx: AppContext, clubId: string, userId: string, balanceCents: number): void {
  ctx.events.emit(rooms.user(userId), 'balance:updated', { clubId, balanceCents });
  ctx.events.emit(rooms.staff(clubId), 'live:changed', { clubId });
}

export async function mint(ctx: AppContext, access: ClubAccess, amountCents: number, reason: string | undefined) {
  if (!can(access, 'points.mint')) throw new AppError('points.mint_owner_only', 403);
  const note = reason?.trim();
  if (!note) throw new AppError('points.reason_required');
  await ctx.db.transaction((tx) => move(tx, {
    clubId: access.club.id, kind: 'mint', from: null, to: POOL, amountCents, actorId: access.user.id, note,
  }));
}

/** Send Out (load) or Claim Back (withdraw) between the staff source and a member's wallet. */
export async function staffTransfer(
  ctx: AppContext, access: ClubAccess, userId: string, direction: 'load' | 'withdraw', amountCents: number, note?: string,
): Promise<number> {
  if (!can(access, 'points.send')) throw new AppError('points.forbidden', 403);
  const clubId = access.club.id;
  await assertMember(ctx, clubId, userId);
  const source = staffSource(access);
  const shortCode = source.kind === 'pool' ? (can(access, 'points.mint') ? 'points.pool_short_owner' : 'points.pool_short') : 'points.stock_short';
  const text = assertNote(note);
  const balance = await ctx.db.transaction(async (tx) => {
    await move(tx, direction === 'load'
      ? { clubId, kind: 'deposit', from: source, to: wallet(userId), amountCents, actorId: access.user.id, note: text, shortCode }
      : { clubId, kind: 'withdrawal', from: wallet(userId), to: source, amountCents, actorId: access.user.id, note: text, userId,
          shortCode: 'points.over_balance' });
    return balanceOf(tx, clubId, wallet(userId));
  });
  notifyBalance(ctx, clubId, userId, balance);
  return balance;
}

export async function moveStock(
  ctx: AppContext, access: ClubAccess, inspectorId: string, direction: 'give' | 'take', amountCents: number, note?: string,
): Promise<number> {
  if (!can(access, 'stock.manage')) throw new AppError('points.stock_forbidden', 403);
  const clubId = access.club.id;
  const [m] = await ctx.db.select({ roles: memberships.roles }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, inspectorId), eq(memberships.status, 'active'))).limit(1);
  if (!m?.roles.includes('inspector')) throw new AppError('points.stock_not_inspector');
  const text = assertNote(note);
  return ctx.db.transaction(async (tx) => {
    const held = await balanceOf(tx, clubId, stock(inspectorId));
    if (direction === 'take' && amountCents > held) {
      throw new AppError('points.stock_take_more_than_held', 409, { stock: held, asked: amountCents });
    }
    await move(tx, direction === 'give'
      ? { clubId, kind: 'stock_give', from: POOL, to: stock(inspectorId), amountCents, actorId: access.user.id, note: text, shortCode: 'points.pool_short_owner' }
      : { clubId, kind: 'stock_take', from: stock(inspectorId), to: POOL, amountCents, actorId: access.user.id, note: text });
    return balanceOf(tx, clubId, stock(inspectorId));
  });
}

export type RequestKind = 'load' | 'cashout';

export async function createPlayerRequest(ctx: AppContext, access: ClubAccess, kind: RequestKind, amountCents: number) {
  if (!access.membership) throw new AppError('club.access_denied', 403);
  const clubId = access.club.id;
  const userId = access.user.id;
  if (kind === 'cashout') {
    const balance = await balanceOf(ctx.db, clubId, wallet(userId));
    if (balance <= 0) throw new AppError('points.nothing_to_return');
    if (amountCents > balance) throw new AppError('points.over_balance', 409, { balance });
  }
  const [pending] = await ctx.db.select({ id: pointRequests.id }).from(pointRequests)
    .where(and(eq(pointRequests.clubId, clubId), eq(pointRequests.userId, userId), eq(pointRequests.kind, kind), eq(pointRequests.status, 'pending'))).limit(1);
  if (pending) throw new AppError('points.request_pending', 409);
  const [row] = await ctx.db.insert(pointRequests).values({ clubId, userId, kind, amountCents }).returning();
  ctx.events.emit(rooms.staff(clubId), 'request:new', { type: kind, id: row!.id });
  return row!;
}

export async function reviewPlayerRequest(
  ctx: AppContext, access: ClubAccess, requestId: string, decision: 'approve' | 'reject', reason?: string,
) {
  if (!can(access, 'requests.review')) throw new AppError('club.review_denied', 403);
  const clubId = access.club.id;
  const result = await ctx.db.transaction(async (tx) => {
    const [req] = await tx.select().from(pointRequests)
      .where(and(eq(pointRequests.id, requestId), eq(pointRequests.clubId, clubId), eq(pointRequests.status, 'pending')))
      .for('update').limit(1);
    if (!req) throw new AppError('club.request_not_found', 404);
    if (decision === 'approve') {
      const source = staffSource(access);
      await move(tx, req.kind === 'load'
        ? { clubId, kind: 'reload', from: source, to: wallet(req.userId), amountCents: req.amountCents, actorId: access.user.id,
            refType: 'request', refId: req.id, shortCode: source.kind === 'pool' ? 'points.pool_short' : 'points.stock_short' }
        : { clubId, kind: 'cashout', from: wallet(req.userId), to: source, amountCents: req.amountCents, actorId: access.user.id,
            userId: req.userId, refType: 'request', refId: req.id, shortCode: 'points.over_balance' });
    }
    const [updated] = await tx.update(pointRequests).set({
      status: decision === 'approve' ? 'approved' : 'rejected', reviewedBy: access.user.id, reviewedAt: ctx.now(),
      rejectionReason: decision === 'reject' ? reason?.trim() || null : null,
    }).where(eq(pointRequests.id, req.id)).returning();
    return { request: updated!, balance: await balanceOf(tx, clubId, wallet(req.userId)) };
  });
  const { request } = result;
  ctx.events.emit(rooms.user(request.userId), 'request:actioned', { type: request.kind, status: request.status, amountCents: request.amountCents });
  ctx.events.emit(rooms.staff(clubId), 'request:resolved', { type: request.kind, id: request.id, byUserId: access.user.id });
  notifyBalance(ctx, clubId, request.userId, result.balance);
  return request;
}

const requestColumns = {
  id: pointRequests.id, userId: pointRequests.userId, kind: pointRequests.kind, amountCents: pointRequests.amountCents,
  status: pointRequests.status, createdAt: pointRequests.createdAt, reviewedAt: pointRequests.reviewedAt,
  rejectionReason: pointRequests.rejectionReason, username: users.username, displayName: users.displayName,
};

export async function listRequests(ctx: AppContext, clubId: string, opts: { status?: string[]; userId?: string; sinceDays?: number }) {
  const conditions = [eq(pointRequests.clubId, clubId)];
  if (opts.status) conditions.push(inArray(pointRequests.status, opts.status));
  if (opts.userId) conditions.push(eq(pointRequests.userId, opts.userId));
  if (opts.sinceDays) conditions.push(gte(pointRequests.createdAt, new Date(ctx.now().getTime() - opts.sinceDays * 86_400_000)));
  return ctx.db.select(requestColumns).from(pointRequests).innerJoin(users, eq(users.id, pointRequests.userId))
    .where(and(...conditions)).orderBy(opts.status?.includes('pending') ? pointRequests.createdAt : desc(pointRequests.createdAt));
}
