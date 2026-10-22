import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { auditLog, clubs, users } from '../../db/schema/index.js';

export interface AuditEntry {
  readonly actorId: string;
  readonly action: string;
  readonly clubId?: string | null;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly data?: Record<string, unknown>;
}

/** Appends one immutable audit row. Pass the transaction handle when inside one. */
export async function writeAudit(db: DbOrTx, now: Date, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    clubId: entry.clubId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    data: entry.data ?? null,
    createdAt: now,
  });
}

export interface AuditQuery {
  readonly page: number;
  readonly limit: number;
  readonly action?: string;
  readonly actorId?: string;
  readonly clubId?: string;
  readonly targetId?: string;
}

async function namesOf(db: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((u) => [u.id, u.displayName ?? u.username]));
}

async function clubNamesOf(db: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: clubs.id, name: clubs.name }).from(clubs).where(inArray(clubs.id, [...new Set(ids)]));
  return new Map(rows.map((c) => [c.id, c.name]));
}

/** Newest first, with actor, club and target names resolved. */
export async function listAudit(ctx: AppContext, q: AuditQuery) {
  const conditions: SQL[] = [];
  if (q.action) conditions.push(eq(auditLog.action, q.action));
  if (q.actorId) conditions.push(eq(auditLog.actorId, q.actorId));
  if (q.clubId) conditions.push(eq(auditLog.clubId, q.clubId));
  if (q.targetId) conditions.push(eq(auditLog.targetId, q.targetId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(auditLog).where(where);
  const rows = await ctx.db.select().from(auditLog).where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(q.limit).offset((q.page - 1) * q.limit);
  const userIds = rows.flatMap((r) => [r.actorId, r.targetType === 'user' ? r.targetId : null]).filter((x): x is string => Boolean(x));
  const people = await namesOf(ctx.db, userIds);
  const clubNames = await clubNamesOf(ctx.db, rows.map((r) => r.clubId).filter((x): x is string => Boolean(x)));
  const actions = await ctx.db.selectDistinct({ action: auditLog.action }).from(auditLog).orderBy(auditLog.action);
  return {
    logs: rows.map((r) => ({
      id: r.id, action: r.action, actorId: r.actorId, actorName: r.actorId ? people.get(r.actorId) ?? null : null,
      clubId: r.clubId, clubName: r.clubId ? clubNames.get(r.clubId) ?? null : null,
      targetType: r.targetType, targetId: r.targetId,
      targetName: r.targetType === 'user' && r.targetId ? people.get(r.targetId) ?? null : null,
      data: r.data ?? {}, createdAt: r.createdAt,
    })),
    pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) },
    actions: actions.map((a) => a.action),
  };
}
