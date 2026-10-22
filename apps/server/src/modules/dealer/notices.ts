import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { dealerNotices } from '../../db/schema/index.js';
import { rooms } from '../../realtime/events.js';

export type NoticeParams = Readonly<Record<string, string | number>>;

export interface DealerNotice {
  readonly id: string;
  readonly code: string;
  readonly params: NoticeParams;
  readonly createdAt: Date;
}

const MAX_NOTICES = 20;

const sameParams = (a: NoticeParams, b: NoticeParams): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/**
 * Stores a persistent notice for a dealer and pushes `notice:new {code, params}` to their sockets.
 * An identical unread notice is reused instead of stacking duplicates.
 */
export async function addDealerNotice(ctx: AppContext, userId: string, code: string, params: NoticeParams): Promise<DealerNotice> {
  const unread = await unreadNotices(ctx.db, userId);
  const existing = unread.find((n) => n.code === code && sameParams(n.params, params));
  const notice = existing ?? await insertNotice(ctx, userId, code, params);
  ctx.events.emit(rooms.user(userId), 'notice:new', { id: notice.id, code, params });
  return notice;
}

async function insertNotice(ctx: AppContext, userId: string, code: string, params: NoticeParams): Promise<DealerNotice> {
  const [row] = await ctx.db.insert(dealerNotices).values({ userId, code, params: { ...params }, createdAt: ctx.now() }).returning();
  return { id: row!.id, code: row!.code, params: row!.params, createdAt: row!.createdAt };
}

export async function unreadNotices(db: DbOrTx, userId: string): Promise<DealerNotice[]> {
  const rows = await db.select().from(dealerNotices)
    .where(and(eq(dealerNotices.userId, userId), isNull(dealerNotices.readAt)))
    .orderBy(desc(dealerNotices.createdAt)).limit(MAX_NOTICES);
  return rows.map((r) => ({ id: r.id, code: r.code, params: r.params, createdAt: r.createdAt }));
}

/** Marks one of the caller's notices read. Returns false when there was nothing of theirs to mark. */
export async function markNoticeRead(ctx: AppContext, userId: string, noticeId: string): Promise<boolean> {
  const updated = await ctx.db.update(dealerNotices).set({ readAt: ctx.now() })
    .where(and(eq(dealerNotices.id, noticeId), eq(dealerNotices.userId, userId), isNull(dealerNotices.readAt)))
    .returning({ id: dealerNotices.id });
  return updated.length > 0;
}
