import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubNotices } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';

export type NoticeParams = Readonly<Record<string, string | number>>;

export interface NoticeInput {
  readonly userId: string;
  readonly clubId: string | null;
  readonly code: string;
  readonly params?: NoticeParams;
}

const MAX_LISTED = 30;

/** Stores a notice (inside the caller's transaction when given `db = tx`). Emit with `emitNotice` after commit. */
export async function addNotice(db: DbOrTx, notice: NoticeInput): Promise<void> {
  await db.insert(clubNotices).values({
    userId: notice.userId, clubId: notice.clubId, code: notice.code, params: { ...(notice.params ?? {}) },
  });
}

export function emitNotice(ctx: AppContext, notice: NoticeInput): void {
  ctx.events.emit(rooms.user(notice.userId), 'notice:new', { code: notice.code, params: notice.params ?? {}, clubId: notice.clubId });
}

/** Stores and pushes a notice in one step (outside transactions). */
export async function notify(ctx: AppContext, notice: NoticeInput): Promise<void> {
  await addNotice(ctx.db, notice);
  emitNotice(ctx, notice);
}

export async function unreadNotices(db: DbOrTx, userId: string) {
  return db.select({
    id: clubNotices.id, clubId: clubNotices.clubId, code: clubNotices.code, params: clubNotices.params, createdAt: clubNotices.createdAt,
  }).from(clubNotices)
    .where(and(eq(clubNotices.userId, userId), isNull(clubNotices.readAt)))
    .orderBy(desc(clubNotices.createdAt)).limit(MAX_LISTED);
}

/** Marks one of the user's notices read. Unknown or already-read notices are a no-op (returns false). */
export async function markNoticeRead(ctx: AppContext, userId: string, noticeId: string): Promise<boolean> {
  const rows = await ctx.db.update(clubNotices).set({ readAt: ctx.now() })
    .where(and(eq(clubNotices.id, noticeId), eq(clubNotices.userId, userId), isNull(clubNotices.readAt)))
    .returning({ id: clubNotices.id });
  return rows.length > 0;
}
