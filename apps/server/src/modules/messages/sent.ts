import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../../db/client.js';
import { clubMessages, coupons, messageRecipients, users, type MessageActionJson } from '../../db/schema/index.js';
import { JOIN_ATTRIBUTION_MS } from './constants.js';
import { getTournamentSource } from './targets.js';

export interface SentStats { readonly reached: number; readonly opened: number; readonly tapped: number; readonly joined: number }

export interface SentItem {
  readonly id: string;
  readonly audience: string;
  readonly recipientName: string | null;
  readonly title: string | null;
  readonly body: string;
  readonly hasPhoto: boolean;
  readonly action: MessageActionJson | null;
  readonly status: string;
  readonly failReason: string | null;
  readonly sendAt: string | null;
  readonly sentAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly authorName: string;
  readonly recipientCount: number;
  readonly mutedCount: number;
  readonly cappedCount: number;
  readonly stats: SentStats;
}

const author = alias(users, 'author');
const recipient = alias(users, 'recipient');

function baseQuery(db: DbOrTx) {
  return db.select({ m: clubMessages, authorName: sql<string>`coalesce(${author.displayName}, ${author.username})`, recipientName: sql<string | null>`coalesce(${recipient.displayName}, ${recipient.username})` })
    .from(clubMessages)
    .innerJoin(author, eq(author.id, clubMessages.authorId))
    .leftJoin(recipient, eq(recipient.id, clubMessages.recipientId));
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

async function countStats(db: DbOrTx, ids: readonly string[]): Promise<Map<string, Omit<SentStats, 'joined'>>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    messageId: messageRecipients.messageId,
    reached: count(),
    opened: sql<number>`count(*) filter (where ${messageRecipients.readAt} is not null or ${messageRecipients.cardShownAt} is not null)`.mapWith(Number),
    tapped: sql<number>`count(${messageRecipients.tappedAt})`.mapWith(Number),
  }).from(messageRecipients).where(inArray(messageRecipients.messageId, [...ids])).groupBy(messageRecipients.messageId);
  return new Map(rows.map((r) => [r.messageId, { reached: r.reached, opened: r.opened, tapped: r.tapped }]));
}

/**
 * "Joined": a recipient who tapped the button and then played the target (a coupon on that table,
 * or in that tournament, or a registration reported by the tournament source) within the window.
 */
async function countJoined(db: DbOrTx, messages: readonly Row[]): Promise<Map<string, number>> {
  const withAction = messages.filter((r) => r.m.action);
  const joined = new Map<string, number>();
  for (const { m } of withAction) {
    const action = m.action!;
    const taps = await db.select({ userId: messageRecipients.userId, tappedAt: messageRecipients.tappedAt }).from(messageRecipients)
      .where(and(eq(messageRecipients.messageId, m.id), isNotNull(messageRecipients.tappedAt)));
    if (taps.length === 0) continue;
    const target = action.type === 'table' ? eq(coupons.tableId, action.ref) : eq(coupons.tournamentId, action.ref);
    const played = await db.selectDistinct({ userId: coupons.userId }).from(coupons).where(and(
      target,
      or(...taps.map((t) => and(
        eq(coupons.userId, t.userId),
        gte(coupons.createdAt, t.tappedAt!),
        lt(coupons.createdAt, new Date(t.tappedAt!.getTime() + JOIN_ATTRIBUTION_MS)),
      ))),
    ));
    const joiners = new Set(played.map((p) => p.userId));
    const source = getTournamentSource();
    if (action.type === 'tournament' && source) {
      const earliest = new Date(Math.min(...taps.map((t) => t.tappedAt!.getTime())));
      (await source.registeredSince(db, action.ref, taps.map((t) => t.userId), earliest)).forEach((u) => joiners.add(u));
    }
    joined.set(m.id, joiners.size);
  }
  return joined;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

async function toItems(db: DbOrTx, rows: readonly Row[]): Promise<SentItem[]> {
  const stats = await countStats(db, rows.map((r) => r.m.id));
  const joined = await countJoined(db, rows);
  return rows.map(({ m, authorName, recipientName }) => ({
    id: m.id, audience: m.audience, recipientName: m.recipientId ? recipientName : null,
    title: m.title, body: m.body, hasPhoto: Boolean(m.photoMime), action: m.action,
    status: m.status, failReason: m.failReason, sendAt: iso(m.sendAt), sentAt: iso(m.sentAt), cancelledAt: iso(m.cancelledAt),
    createdAt: m.createdAt.toISOString(), authorName,
    recipientCount: m.recipientCount, mutedCount: m.mutedCount, cappedCount: m.cappedCount,
    stats: { ...(stats.get(m.id) ?? { reached: 0, opened: 0, tapped: 0 }), joined: joined.get(m.id) ?? 0 },
  }));
}

/** GET /messages/sent: waiting messages first (soonest first), then the log (newest first, paginated). */
export async function listSent(db: DbOrTx, clubId: string, opts: { limit: number; before?: Date }) {
  const scheduledRows = await baseQuery(db)
    .where(and(eq(clubMessages.clubId, clubId), eq(clubMessages.status, 'scheduled')))
    .orderBy(asc(clubMessages.sendAt));
  const logRows = await baseQuery(db)
    .where(and(
      eq(clubMessages.clubId, clubId), ne(clubMessages.status, 'scheduled'),
      opts.before ? lt(clubMessages.createdAt, opts.before) : undefined,
    ))
    .orderBy(desc(clubMessages.createdAt)).limit(opts.limit + 1);
  const page = logRows.slice(0, opts.limit);
  return {
    scheduled: await toItems(db, scheduledRows),
    messages: await toItems(db, page),
    hasMore: logRows.length > opts.limit,
  };
}
