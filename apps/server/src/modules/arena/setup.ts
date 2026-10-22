import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { Db } from '../../db/client.js';
import { clubTables, clubs, users, type TableLimitsJson } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { arenaConfig, dealSeconds, UNLIMITED_CENTS } from './config.js';

/** clubs.settings.kind of the platform Arena pseudo-club. Other modules exclude it from club figures. */
export const ARENA_KIND = 'arena';
/** Reserved Club ID: outside the 1000000–9999999 range normal clubs draw from, so nobody can find or join it. */
export const ARENA_PUBLIC_ID = '0000000';
/** clubs.status of the Arena: not 'active', so it never appears in club lists or searches. */
export const ARENA_STATUS = 'platform';
const SYSTEM_USERNAME = 'getflop.arena';

export interface ArenaIds {
  readonly clubId: string;
  readonly tableId: string;
}

export function isArenaClub(club: { settings: Record<string, unknown> | null }): boolean {
  return club.settings?.kind === ARENA_KIND;
}

export function arenaLimits(): TableLimitsJson {
  const cfg = arenaConfig();
  return { minCents: cfg.minPickCents, maxCents: UNLIMITED_CENTS, couponCapCents: UNLIMITED_CENTS, maxRounds: cfg.maxRounds, marketMaxCents: {} };
}

async function systemUser(db: Db): Promise<string> {
  const [found] = await db.select({ id: users.id }).from(users).where(eq(users.username, SYSTEM_USERNAME)).limit(1);
  if (found) return found.id;
  await db.insert(users).values({
    username: SYSTEM_USERNAME, displayName: 'GetFlop', pinHash: 'disabled', isActive: false, // no PIN can match: the account never signs in
  }).onConflictDoNothing();
  const [created] = await db.select({ id: users.id }).from(users).where(eq(users.username, SYSTEM_USERNAME)).limit(1);
  return created!.id;
}

async function arenaClub(db: Db, now: Date): Promise<string> {
  const [found] = await db.select({ id: clubs.id }).from(clubs).where(eq(clubs.publicId, ARENA_PUBLIC_ID)).limit(1);
  if (found) return found.id;
  const ownerId = await systemUser(db);
  await db.insert(clubs).values({
    publicId: ARENA_PUBLIC_ID, name: 'GetFlop Arena', ownerId, status: ARENA_STATUS,
    settings: { kind: ARENA_KIND }, termsAcceptedAt: now,
  }).onConflictDoNothing();
  const [created] = await db.select({ id: clubs.id }).from(clubs).where(eq(clubs.publicId, ARENA_PUBLIC_ID)).limit(1);
  return created!.id;
}

async function arenaTable(db: Db, clubId: string): Promise<string> {
  const cfg = arenaConfig();
  const values = { status: 'open', isAutoDeal: true, autoDealSeconds: dealSeconds(cfg), limits: arenaLimits(), dealerId: null };
  const [found] = await db.select({ id: clubTables.id }).from(clubTables)
    .where(and(eq(clubTables.clubId, clubId), eq(clubTables.kind, ARENA_KIND))).orderBy(clubTables.createdAt).limit(1);
  if (found) {
    await db.update(clubTables).set(values).where(eq(clubTables.id, found.id));
    return found.id;
  }
  const [created] = await db.insert(clubTables).values({ clubId, name: 'Arena', kind: ARENA_KIND, game: 'nlh', ...values }).returning();
  return created!.id;
}

const cache = new WeakMap<object, Promise<ArenaIds>>();

/** Creates the Arena club and its table on first use (idempotent across restarts). */
export function ensureArena(ctx: AppContext): Promise<ArenaIds> {
  let pending = cache.get(ctx.db);
  if (!pending) {
    pending = (async () => {
      const clubId = await arenaClub(ctx.db, ctx.now());
      return { clubId, tableId: await arenaTable(ctx.db, clubId) };
    })();
    pending.catch((err: unknown) => {
      cache.delete(ctx.db);
      ctx.logger.error('Arena setup failed', err);
    });
    cache.set(ctx.db, pending);
  }
  return pending.catch(() => { throw new AppError('arena.unavailable', 503); });
}
