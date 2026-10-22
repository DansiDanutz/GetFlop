import { and, asc, eq, lte } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubMessages, memberships, messageRecipients, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { can, loadClubAccess } from '../clubs/access.js';
import { isAudienceKey, reachFor } from './audiences.js';
import { MEMBER_AUDIENCE, type FailReason } from './constants.js';

export type MessageRow = typeof clubMessages.$inferSelect;

export type Resolution =
  | { readonly ok: true; readonly userIds: readonly string[]; readonly muted: number; readonly capped: number; readonly isDirect: boolean }
  | { readonly ok: false; readonly reason: FailReason; readonly muted: number; readonly capped: number };

export async function isActiveMember(db: DbOrTx, clubId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: memberships.id }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(users.isActive, true)))
    .limit(1);
  return Boolean(row);
}

/** Who a message reaches right now: a direct message always arrives; a group message skips muted and capped members. */
export async function resolveRecipients(db: DbOrTx, msg: Pick<MessageRow, 'clubId' | 'audience' | 'recipientId' | 'tz' | 'authorId'>, now: Date): Promise<Resolution> {
  if (msg.audience === MEMBER_AUDIENCE) {
    if (!msg.recipientId || !await isActiveMember(db, msg.clubId, msg.recipientId)) {
      return { ok: false, reason: 'member_left', muted: 0, capped: 0 };
    }
    return { ok: true, userIds: [msg.recipientId], muted: 0, capped: 0, isDirect: true };
  }
  if (!isAudienceKey(msg.audience)) return { ok: false, reason: 'nobody', muted: 0, capped: 0 };
  const reach = await reachFor(db, msg.audience, { clubId: msg.clubId, now, tz: msg.tz, excludeUserId: msg.authorId });
  if (reach.deliverable.length === 0) return { ok: false, reason: 'nobody', muted: reach.muted, capped: reach.capped };
  return { ok: true, userIds: reach.deliverable, muted: reach.muted, capped: reach.capped, isDirect: false };
}

/** Writes the recipient rows (inside the caller's transaction). */
export async function insertRecipients(db: DbOrTx, msg: Pick<MessageRow, 'id' | 'clubId'>, userIds: readonly string[], isDirect: boolean, now: Date): Promise<void> {
  if (userIds.length === 0) return;
  await db.insert(messageRecipients)
    .values(userIds.map((userId) => ({ messageId: msg.id, clubId: msg.clubId, userId, isDirect, deliveredAt: now })))
    .onConflictDoNothing();
}

/** Realtime fan-out after the delivery transaction commits. */
export function announce(ctx: AppContext, msg: Pick<MessageRow, 'id' | 'clubId'>, userIds: readonly string[]): void {
  for (const userId of userIds) ctx.events.emit(rooms.user(userId), 'message:new', { messageId: msg.id, clubId: msg.clubId });
  ctx.events.emit(rooms.staff(msg.clubId), 'messages:changed', { messageId: msg.id });
}

async function writerStillManages(db: DbOrTx, msg: MessageRow): Promise<boolean> {
  const [author] = await db.select().from(users).where(eq(users.id, msg.authorId)).limit(1);
  if (!author || !author.isActive || author.deletedAt) return false;
  try {
    return can(await loadClubAccess(db, author, msg.clubId), 'messages');
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
}

interface Outcome { readonly msg: MessageRow; readonly userIds: readonly string[]; readonly reason: FailReason | null }

async function deliverScheduled(ctx: AppContext, id: string): Promise<Outcome | null> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [msg] = await tx.select().from(clubMessages).where(eq(clubMessages.id, id)).for('update').limit(1);
    if (!msg || msg.status !== 'scheduled') return null;
    const fail = async (reason: FailReason, muted = 0, capped = 0): Promise<Outcome> => {
      const [row] = await tx.update(clubMessages)
        .set({ status: 'failed', failReason: reason, mutedCount: muted, cappedCount: capped })
        .where(eq(clubMessages.id, id)).returning();
      return { msg: row!, userIds: [], reason };
    };
    if (!await writerStillManages(tx, msg)) return fail('writer_gone');
    const resolution = await resolveRecipients(tx, msg, now);
    if (!resolution.ok) return fail(resolution.reason, resolution.muted, resolution.capped);
    await insertRecipients(tx, msg, resolution.userIds, resolution.isDirect, now);
    const [row] = await tx.update(clubMessages).set({
      status: 'sent', sentAt: now, recipientCount: resolution.userIds.length,
      mutedCount: resolution.muted, cappedCount: resolution.capped,
    }).where(eq(clubMessages.id, id)).returning();
    return { msg: row!, userIds: resolution.userIds, reason: null };
  });
}

async function markInterrupted(ctx: AppContext, id: string): Promise<MessageRow | null> {
  const [row] = await ctx.db.update(clubMessages).set({ status: 'failed', failReason: 'interrupted' })
    .where(and(eq(clubMessages.id, id), eq(clubMessages.status, 'scheduled'))).returning();
  return row ?? null;
}

function notifyWriter(ctx: AppContext, msg: MessageRow, reason: FailReason | null, count: number): void {
  const code = reason ? 'messages.scheduled_failed' : 'messages.scheduled_sent';
  ctx.events.emit(rooms.user(msg.authorId), 'notice:new', { code, params: reason ? { reason } : { count } });
}

/** Background job: sends every scheduled message that is due. Returns how many were processed. */
export async function deliverDueMessages(ctx: AppContext): Promise<number> {
  const due = await ctx.db.select({ id: clubMessages.id }).from(clubMessages)
    .where(and(eq(clubMessages.status, 'scheduled'), lte(clubMessages.sendAt, ctx.now())))
    .orderBy(asc(clubMessages.sendAt));
  for (const { id } of due) {
    try {
      const outcome = await deliverScheduled(ctx, id);
      if (!outcome) continue;
      if (outcome.userIds.length > 0) announce(ctx, outcome.msg, outcome.userIds);
      else ctx.events.emit(rooms.staff(outcome.msg.clubId), 'messages:changed', { messageId: id });
      notifyWriter(ctx, outcome.msg, outcome.reason, outcome.userIds.length);
    } catch (err) {
      ctx.logger.error(`Scheduled message ${id} failed`, err);
      const row = await markInterrupted(ctx, id);
      if (row) notifyWriter(ctx, row, 'interrupted', 0);
    }
  }
  return due.length;
}

