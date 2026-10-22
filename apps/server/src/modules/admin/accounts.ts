import { and, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubs, memberships, sessions, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import { hashSecret } from '../auth/crypto.js';
import { deviceLabel } from '../auth/revocation.js';
import type { AuthUser } from '../auth/session.js';
import { assertName, assertUsername, PIN_RE } from '../auth/validation.js';
import { writeAudit } from './audit.js';

export type AccountFilter = 'all' | 'players' | 'admins' | 'inactive' | 'bots';
export type AccountRole = 'player' | 'admin' | 'bot';
type UserRow = typeof users.$inferSelect;

const NAME_MAX = 30;

export function roleOf(u: Pick<UserRow, 'isBot' | 'isPlatformAdmin'>): AccountRole {
  if (u.isBot) return 'bot';
  return u.isPlatformAdmin ? 'admin' : 'player';
}

/** The account as the admin console sees it. Never includes the PIN hash. */
export function adminUserView(u: UserRow) {
  return {
    id: u.id, username: u.username, displayName: u.displayName ?? u.username, email: u.email,
    emailVerified: Boolean(u.emailVerifiedAt), role: roleOf(u), isActive: u.isActive,
    isAdmin: u.isPlatformAdmin, isBot: u.isBot, language: u.language, createdAt: u.createdAt,
    signsInWith: u.googleSub ? ['pin', 'google'] : ['pin'],
  };
}

const notDeleted = isNull(users.deletedAt);

const FILTERS: Record<AccountFilter, SQL | undefined> = {
  all: undefined,
  players: and(eq(users.isPlatformAdmin, false), eq(users.isBot, false)),
  admins: eq(users.isPlatformAdmin, true),
  inactive: eq(users.isActive, false),
  bots: eq(users.isBot, true),
};

export async function accountCounts(db: DbOrTx): Promise<Record<AccountFilter, number>> {
  const n = (cond: SQL | undefined) => sql<number>`cast(count(*) filter (where ${cond ?? sql`true`}) as int)`;
  const [row] = await db.select({
    all: n(undefined), players: n(FILTERS.players), admins: n(FILTERS.admins), inactive: n(FILTERS.inactive), bots: n(FILTERS.bots),
  }).from(users).where(notDeleted);
  return { all: row?.all ?? 0, players: row?.players ?? 0, admins: row?.admins ?? 0, inactive: row?.inactive ?? 0, bots: row?.bots ?? 0 };
}

const likeEscape = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function clubsOf(db: DbOrTx, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  return db.select({ userId: memberships.userId, id: clubs.id, name: clubs.name })
    .from(memberships).innerJoin(clubs, eq(clubs.id, memberships.clubId))
    .where(and(inArray(memberships.userId, [...userIds]), eq(memberships.status, 'active'), ne(clubs.status, 'deleted')));
}

async function devicesOf(db: DbOrTx, userIds: readonly string[]) {
  if (userIds.length === 0) return [];
  const rows = await db.select({ userId: sessions.userId, userAgent: sessions.userAgent, createdAt: sessions.createdAt })
    .from(sessions).where(inArray(sessions.userId, [...userIds])).orderBy(desc(sessions.createdAt));
  return rows.map((r) => ({ userId: r.userId, device: deviceLabel(r.userAgent ?? undefined), signedInAt: r.createdAt }));
}

export interface AccountListQuery {
  readonly filter: AccountFilter;
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export async function listAccounts(ctx: AppContext, query: AccountListQuery) {
  const search = query.q?.trim();
  const where = and(
    notDeleted,
    FILTERS[query.filter],
    search ? or(ilike(users.username, likeEscape(search)), ilike(users.displayName, likeEscape(search)), ilike(users.email, likeEscape(search))) : undefined,
  );
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(users).where(where);
  const rows = await ctx.db.select().from(users).where(where)
    .orderBy(desc(users.createdAt), users.username).limit(query.limit).offset(query.offset);
  const ids = rows.map((u) => u.id);
  const [clubRows, devices] = [await clubsOf(ctx.db, ids), await devicesOf(ctx.db, ids)];
  return {
    accounts: rows.map((u) => {
      const mine = devices.filter((d) => d.userId === u.id);
      return {
        ...adminUserView(u),
        clubs: clubRows.filter((c) => c.userId === u.id).map((c) => ({ id: c.id, name: c.name })),
        lastSeenAt: mine[0]?.signedInAt ?? null,
        devices: [...new Set(mine.map((d) => d.device))],
      };
    }),
    total,
    counts: await accountCounts(ctx.db),
  };
}

export async function findUser(db: DbOrTx, id: string): Promise<UserRow> {
  const [user] = await db.select().from(users).where(and(eq(users.id, id), notDeleted)).limit(1);
  if (!user) throw new AppError('admin.user_not_found', 404);
  return user;
}

/** Legacy user table: every account, newest first. */
export async function listUsers(ctx: AppContext) {
  const rows = await ctx.db.select().from(users).where(notDeleted).orderBy(desc(users.createdAt), users.username);
  return { users: rows.map(adminUserView) };
}

async function assertUsernameFree(db: DbOrTx, username: string, exceptId?: string): Promise<void> {
  const [taken] = await db.select({ id: users.id }).from(users)
    .where(and(sql`lower(${users.username}) = lower(${username})`, exceptId ? ne(users.id, exceptId) : undefined)).limit(1);
  if (taken) throw new AppError('admin.username_taken', 409);
}

const validDisplayName = (name: string) => assertName(name, { min: 1, max: NAME_MAX, code: 'admin.name_length' });

function validPin(pin: string): string {
  if (!PIN_RE.test(pin)) throw new AppError('admin.pin_digits');
  return pin;
}

export interface CreateUserInput {
  readonly username?: string;
  readonly displayName?: string;
  readonly role?: string;
  readonly pin?: string;
}

export async function createUser(ctx: AppContext, actor: AuthUser, input: CreateUserInput) {
  const username = input.username?.trim();
  if (!username || !input.pin || !input.role) throw new AppError('admin.create_missing');
  if (input.role !== 'player' && input.role !== 'admin') throw new AppError('admin.role_invalid');
  assertUsername(username);
  const pin = validPin(input.pin);
  const displayName = validDisplayName(input.displayName ?? username);
  await assertUsernameFree(ctx.db, username);
  const isPlatformAdmin = input.role === 'admin';
  const user = await ctx.db.transaction(async (tx) => {
    const [created] = await tx.insert(users).values({
      username, displayName, pinHash: await hashSecret(pin), isPlatformAdmin, createdAt: ctx.now(),
    }).returning();
    await writeAudit(tx, ctx.now(), {
      actorId: actor.id, action: 'create_user', targetType: 'user', targetId: created!.id,
      data: { username, displayName, role: input.role },
    });
    return created!;
  });
  return { user: adminUserView(user) };
}

export interface UpdateUserInput {
  readonly username?: string;
  readonly displayName?: string;
}

export async function updateUser(ctx: AppContext, actor: AuthUser, id: string, input: UpdateUserInput) {
  const before = await findUser(ctx.db, id);
  const username = input.username === undefined ? before.username : assertUsername(input.username.trim());
  const displayName = input.displayName === undefined ? before.displayName : validDisplayName(input.displayName);
  if (username.toLowerCase() !== before.username.toLowerCase()) await assertUsernameFree(ctx.db, username, id);
  const user = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx.update(users).set({ username, displayName }).where(eq(users.id, id)).returning();
    await writeAudit(tx, ctx.now(), {
      actorId: actor.id, action: 'update_user', targetType: 'user', targetId: id,
      data: { before: { username: before.username, displayName: before.displayName }, after: { username, displayName } },
    });
    return updated!;
  });
  return { user: adminUserView(user) };
}

/** Deactivation signs the user out everywhere at once and blocks sign-in; nothing else is touched. */
export async function setActive(ctx: AppContext, actor: AuthUser, id: string, active: boolean) {
  if (!active && id === actor.id) throw new AppError('admin.self_deactivate', 409);
  await findUser(ctx.db, id);
  const { user, ended } = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx.update(users).set({ isActive: active }).where(eq(users.id, id)).returning();
    const removed = active ? [] : await tx.delete(sessions).where(eq(sessions.userId, id)).returning({ id: sessions.id });
    await writeAudit(tx, ctx.now(), {
      actorId: actor.id, action: active ? 'activate_user' : 'deactivate_user', targetType: 'user', targetId: id,
      data: { sessionsEnded: removed.length },
    });
    return { user: updated!, ended: removed.length };
  });
  if (!active) ctx.events.emit(rooms.user(id), 'session:ended', { reason: 'deactivated', deviceLabel: null });
  return { user: adminUserView(user), sessionsEnded: ended };
}

/** The admin tells the person the new PIN; the user's current sign-in stays open. */
export async function resetPin(ctx: AppContext, actor: AuthUser, id: string, newPin: string) {
  const pin = validPin(newPin);
  await findUser(ctx.db, id);
  await ctx.db.transaction(async (tx) => {
    await tx.update(users).set({ pinHash: await hashSecret(pin), failedLogins: 0, lockedUntil: null }).where(eq(users.id, id));
    await writeAudit(tx, ctx.now(), { actorId: actor.id, action: 'reset_pin', targetType: 'user', targetId: id });
  });
  return { ok: true };
}
