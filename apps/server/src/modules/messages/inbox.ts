import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubMessages, clubs, memberships, messagePrefs, messageRecipients, type MessageActionJson } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';
import { loadClubAccess, type ClubAccess } from '../clubs/access.js';
import { INBOX_LIMIT } from './constants.js';
import { photoDataUrl } from './photo.js';
import { openTables, tournamentTargets } from './targets.js';

export interface InboxItem {
  readonly id: string;
  readonly clubId: string;
  readonly clubName: string;
  readonly clubPhotoUrl: string | null;
  readonly title: string | null;
  readonly body: string;
  readonly hasPhoto: boolean;
  readonly action: MessageActionJson | null;
  readonly direct: boolean;
  readonly deliveredAt: string;
  readonly read: boolean;
}

const itemColumns = {
  id: clubMessages.id, clubId: clubMessages.clubId, clubName: clubs.name, clubPhotoUrl: clubs.photoUrl,
  title: clubMessages.title, body: clubMessages.body, photoMime: clubMessages.photoMime, action: clubMessages.action,
  direct: messageRecipients.isDirect, deliveredAt: messageRecipients.deliveredAt, readAt: messageRecipients.readAt,
};

interface ItemRow {
  id: string; clubId: string; clubName: string; clubPhotoUrl: string | null; title: string | null; body: string;
  photoMime: string | null; action: MessageActionJson | null; direct: boolean; deliveredAt: Date; readAt: Date | null;
}

const toItem = (r: ItemRow): InboxItem => ({
  id: r.id, clubId: r.clubId, clubName: r.clubName, clubPhotoUrl: r.clubPhotoUrl, title: r.title, body: r.body,
  hasPhoto: Boolean(r.photoMime), action: r.action, direct: r.direct, deliveredAt: r.deliveredAt.toISOString(), read: Boolean(r.readAt),
});

function inboxQuery(db: DbOrTx, userId: string) {
  return db.select(itemColumns).from(messageRecipients)
    .innerJoin(clubMessages, eq(clubMessages.id, messageRecipients.messageId))
    .innerJoin(clubs, eq(clubs.id, messageRecipients.clubId))
    .innerJoin(memberships, and(eq(memberships.clubId, messageRecipients.clubId), eq(memberships.userId, userId), eq(memberships.status, 'active')));
}

/** GET /messages: my messages from the clubs I am in, newest first. */
export async function listInbox(db: DbOrTx, userId: string): Promise<{ messages: InboxItem[]; unread: number }> {
  const rows = await inboxQuery(db, userId).where(eq(messageRecipients.userId, userId))
    .orderBy(desc(messageRecipients.deliveredAt)).limit(INBOX_LIMIT);
  const messages = (rows as ItemRow[]).map(toItem);
  return { messages, unread: messages.filter((m) => !m.read).length };
}

export async function readAll(ctx: AppContext, userId: string): Promise<{ updated: number }> {
  const rows = await ctx.db.update(messageRecipients).set({ readAt: ctx.now() })
    .where(and(eq(messageRecipients.userId, userId), isNull(messageRecipients.readAt)))
    .returning({ id: messageRecipients.id });
  return { updated: rows.length };
}

/** Pending full-screen photo cards for the club being entered (each shows once). */
export async function pendingCards(db: DbOrTx, userId: string, clubId: string): Promise<InboxItem[]> {
  const rows = await inboxQuery(db, userId).where(and(
    eq(messageRecipients.userId, userId), eq(messageRecipients.clubId, clubId),
    isNotNull(clubMessages.photoMime), isNull(messageRecipients.cardShownAt), isNull(messageRecipients.readAt),
  )).orderBy(desc(messageRecipients.deliveredAt)).limit(5);
  return (rows as ItemRow[]).map(toItem);
}

async function myCopy(db: DbOrTx, userId: string, messageId: string) {
  const [row] = await db.select({ recipient: messageRecipients, message: clubMessages }).from(messageRecipients)
    .innerJoin(clubMessages, eq(clubMessages.id, messageRecipients.messageId))
    .where(and(eq(messageRecipients.messageId, messageId), eq(messageRecipients.userId, userId))).limit(1);
  if (!row) throw new AppError('messages.not_found', 404);
  return row;
}

export async function markCardShown(ctx: AppContext, userId: string, messageId: string): Promise<{ ok: true }> {
  const { recipient } = await myCopy(ctx.db, userId, messageId);
  if (!recipient.cardShownAt) {
    await ctx.db.update(messageRecipients).set({ cardShownAt: ctx.now() }).where(eq(messageRecipients.id, recipient.id));
  }
  return { ok: true };
}

/** POST /messages/:id/tap: records the first tap and tells the client whether the target still exists. */
export async function tapAction(ctx: AppContext, userId: string, messageId: string) {
  const { recipient, message } = await myCopy(ctx.db, userId, messageId);
  const action = message.action;
  if (!action) throw new AppError('messages.action_unknown', 400);
  const now = ctx.now();
  await ctx.db.update(messageRecipients)
    .set({ tappedAt: recipient.tappedAt ?? now, readAt: recipient.readAt ?? now })
    .where(eq(messageRecipients.id, recipient.id));
  const targets = action.type === 'table' ? await openTables(ctx.db, message.clubId) : await tournamentTargets(ctx.db, message.clubId, now);
  return { type: action.type, ref: action.ref, clubId: message.clubId, available: targets.some((x) => x.id === action.ref) };
}

/** GET /messages/:id/photo: the recipient, or staff of the sending club (sent log preview). */
export async function messagePhoto(db: DbOrTx, user: AuthUser, messageId: string): Promise<{ photo: string | null }> {
  const [message] = await db.select().from(clubMessages).where(eq(clubMessages.id, messageId)).limit(1);
  if (!message) throw new AppError('messages.not_found', 404);
  const [copy] = await db.select({ id: messageRecipients.id }).from(messageRecipients)
    .where(and(eq(messageRecipients.messageId, messageId), eq(messageRecipients.userId, user.id))).limit(1);
  if (!copy) {
    const access = await loadClubAccess(db, user, message.clubId).catch(() => null);
    if (!access || (access.rank < 2 && !access.isAdmin)) throw new AppError('messages.not_found', 404);
  }
  return { photo: message.photoData && message.photoMime ? photoDataUrl(message.photoMime, message.photoData) : null };
}

export async function getPrefs(db: DbOrTx, access: ClubAccess) {
  const [row] = await db.select().from(messagePrefs)
    .where(and(eq(messagePrefs.clubId, access.club.id), eq(messagePrefs.userId, access.user.id))).limit(1);
  return { clubId: access.club.id, clubName: access.club.name, promoMuted: row?.promoMuted ?? false };
}

export async function setPrefs(ctx: AppContext, access: ClubAccess, promoMuted: boolean) {
  await ctx.db.insert(messagePrefs)
    .values({ clubId: access.club.id, userId: access.user.id, promoMuted, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: [messagePrefs.clubId, messagePrefs.userId], set: { promoMuted, updatedAt: ctx.now() } });
  return getPrefs(ctx.db, access);
}
