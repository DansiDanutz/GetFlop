import { and, count, desc, eq, gte, isNull, lt, max } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubs, clubTables, floorSessions, hands } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { totals } from './metrics.js';
import { settledBets, userNames } from './queries.js';
import { clubTz, nextCutoff, OPEN_END, type Range } from './time.js';

export type SessionRow = typeof floorSessions.$inferSelect;
const RECENT_LIMIT = 10;

export interface SessionSummary { hands: number; players: number; handleCents: number; resultCents: number }

/** Ring Game figures of a window (real players, Points). */
export async function windowSummary(db: DbOrTx, clubId: string, range: Range): Promise<SessionSummary> {
  const bets = await settledBets(db, clubId, { range, unit: 'points' });
  const [dealt] = await db.select({ n: count() }).from(hands).innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .where(and(eq(hands.clubId, clubId), eq(hands.status, 'settled'), eq(clubTables.kind, 'cash'),
      gte(hands.settledAt, range.from), lt(hands.settledAt, range.to)));
  const t = totals(bets);
  return { hands: dealt?.n ?? 0, players: t.players, handleCents: t.handleCents, resultCents: t.resultCents };
}

async function openSessionRow(db: DbOrTx, clubId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(floorSessions)
    .where(and(eq(floorSessions.clubId, clubId), isNull(floorSessions.closedAt))).limit(1);
  return row ?? null;
}

async function closeRow(ctx: AppContext, row: SessionRow, closedAt: Date, closedBy: string | null, reason: 'manual' | 'auto') {
  const summary = await windowSummary(ctx.db, row.clubId, { from: row.openedAt, to: closedAt });
  const [closed] = await ctx.db.update(floorSessions).set({ closedAt, closedBy, closedReason: reason, summary: { ...summary } })
    .where(and(eq(floorSessions.id, row.id), isNull(floorSessions.closedAt))).returning();
  return closed ?? null;
}

/** Closes a session left open past its 06:00 cut-off (club local time). */
export async function autoCloseIfDue(ctx: AppContext, clubId: string, settings: Record<string, unknown>): Promise<void> {
  const open = await openSessionRow(ctx.db, clubId);
  if (!open) return;
  const cutoff = nextCutoff(open.openedAt, clubTz(settings));
  if (cutoff.getTime() > ctx.now().getTime()) return;
  const closed = await closeRow(ctx, open, cutoff, null, 'auto');
  if (closed) ctx.events.emit(rooms.staff(clubId), 'live:changed', { kind: 'bets' });
}

/** Background job: auto-close every overdue session. */
export async function autoCloseSessions(ctx: AppContext): Promise<number> {
  const open = await ctx.db.select({ clubId: floorSessions.clubId, settings: clubs.settings }).from(floorSessions)
    .innerJoin(clubs, eq(clubs.id, floorSessions.clubId)).where(isNull(floorSessions.closedAt));
  for (const s of open) await autoCloseIfDue(ctx, s.clubId, s.settings);
  return open.length;
}

async function insertSession(ctx: AppContext, clubId: string, userId: string, openedAt: Date): Promise<SessionRow> {
  const [last] = await ctx.db.select({ n: max(floorSessions.number) }).from(floorSessions).where(eq(floorSessions.clubId, clubId));
  const [row] = await ctx.db.insert(floorSessions).values({ clubId, number: (last?.n ?? 0) + 1, openedAt, openedBy: userId }).returning();
  return row!;
}

async function view(ctx: AppContext, row: SessionRow, names: Map<string, string>) {
  const summary = row.closedAt ? row.summary : await windowSummary(ctx.db, row.clubId, { from: row.openedAt, to: OPEN_END });
  return {
    id: row.id, number: row.number, openedAt: row.openedAt, closedAt: row.closedAt, closedReason: row.closedReason,
    openedBy: row.openedBy ? names.get(row.openedBy) ?? null : null, closedBy: row.closedBy ? names.get(row.closedBy) ?? null : null,
    summary,
  };
}

export async function sessionOverview(ctx: AppContext, access: ClubAccess) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  await autoCloseIfDue(ctx, clubId, access.club.settings);
  const rows = await ctx.db.select().from(floorSessions).where(eq(floorSessions.clubId, clubId))
    .orderBy(desc(floorSessions.number)).limit(RECENT_LIMIT + 1);
  const names = await userNames(ctx.db, rows.flatMap((r) => [r.openedBy, r.closedBy]));
  const open = rows.find((r) => !r.closedAt);
  return {
    open: open ? await view(ctx, open, names) : null,
    recent: await Promise.all(rows.filter((r) => r.closedAt).slice(0, RECENT_LIMIT).map((r) => view(ctx, r, names))),
  };
}

/** Opens a session now (returns the open one if there is one already). */
export async function openSession(ctx: AppContext, access: ClubAccess) {
  assertCan(access, 'reports');
  await autoCloseIfDue(ctx, access.club.id, access.club.settings);
  const existing = await openSessionRow(ctx.db, access.club.id);
  const row = existing ?? await insertSession(ctx, access.club.id, access.user.id, ctx.now());
  ctx.events.emit(rooms.staff(access.club.id), 'live:changed', { kind: 'bets' });
  return view(ctx, row, await userNames(ctx.db, [row.openedBy]));
}

/** Closes the open session with its summary and starts the next one at once. */
export async function closeSession(ctx: AppContext, access: ClubAccess) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  await autoCloseIfDue(ctx, clubId, access.club.settings);
  const open = await openSessionRow(ctx.db, clubId);
  if (!open) throw new AppError('session.not_found', 404);
  const now = ctx.now();
  const closed = await closeRow(ctx, open, now, access.user.id, 'manual');
  if (!closed) throw new AppError('session.not_found', 404);
  const next = await insertSession(ctx, clubId, access.user.id, now);
  ctx.events.emit(rooms.staff(clubId), 'live:changed', { kind: 'bets' });
  const names = await userNames(ctx.db, [closed.openedBy, closed.closedBy, next.openedBy]);
  return { closed: await view(ctx, closed, names), next: await view(ctx, next, names) };
}

export async function findSession(ctx: AppContext, clubId: string, sessionId: string): Promise<SessionRow> {
  const [row] = await ctx.db.select().from(floorSessions)
    .where(and(eq(floorSessions.id, sessionId), eq(floorSessions.clubId, clubId))).limit(1);
  if (!row) throw new AppError('session.not_found', 404);
  return row;
}

export async function currentOpenSession(ctx: AppContext, access: ClubAccess): Promise<SessionRow | null> {
  await autoCloseIfDue(ctx, access.club.id, access.club.settings);
  return openSessionRow(ctx.db, access.club.id);
}
