import { and, count, eq, gte, ne } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import {
  clubMessages, clubs, clubTables, commerceVersions, memberships, rooms, tournaments, type LevelLimitsJson,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, type ClubAccess, type Club } from '../clubs/access.js';
import { getBilling, isPaused } from './billing.js';
import { levelOffer, levelOffers } from './catalogue.js';
import { levelOf, nextLevel } from './levels.js';

export type Resource = 'members' | 'ringGames' | 'tournaments' | 'rooms' | 'broadcasts';

/** Error code stems per resource (commerce.capacity_<stem>_billing / _staff). */
const STEM: Record<Resource, string> = {
  members: 'members', ringGames: 'ring_games', tournaments: 'tournaments', rooms: 'rooms', broadcasts: 'broadcasts',
};

/** Free messaging period: broadcasts are not limited before this date. */
export const BROADCAST_QUOTA_FROM = new Date('2026-12-01T00:00:00Z');

/**
 * One free Starter club per owner. The owner's earliest-created active Starter club holds the free slot;
 * any other Starter club of the same owner is level-locked until it moves to a paid Level.
 */
export async function freeClubOf(db: DbOrTx, ownerId: string): Promise<Club | null> {
  const [first] = await db.select().from(clubs)
    .where(and(eq(clubs.ownerId, ownerId), eq(clubs.level, 'starter'), eq(clubs.status, 'active')))
    .orderBy(clubs.createdAt, clubs.id).limit(1);
  return first ?? null;
}

export async function isLevelLocked(db: DbOrTx, club: Club): Promise<boolean> {
  if (club.level !== 'starter') return false;
  const free = await freeClubOf(db, club.ownerId);
  return Boolean(free && free.id !== club.id);
}

/** Limits of the club's current period (the Level version it paid for), falling back to the published default. */
export async function clubLimits(db: DbOrTx, clubId: string, at: Date): Promise<{ code: string; name: string; limits: LevelLimitsJson }> {
  const billing = await getBilling(db, clubId, at);
  const offer = await levelOffer(db, billing.levelCode, at);
  if (billing.levelVersionId) {
    const [v] = await db.select().from(commerceVersions).where(eq(commerceVersions.id, billing.levelVersionId));
    if (v?.limits) return { code: billing.levelCode, name: offer?.name ?? levelOf(billing.levelCode).name, limits: v.limits };
  }
  if (offer) return { code: offer.code, name: offer.name, limits: offer.limits };
  const l = levelOf(billing.levelCode);
  return { code: l.code, name: l.name, limits: { members: l.members, ringGames: l.ringGames, tournaments: l.tournaments, rooms: l.rooms, broadcasts: null } };
}

const n = (rows: { n: number }[]): number => rows[0]?.n ?? 0;

export async function usageOf(db: DbOrTx, clubId: string, at: Date): Promise<Record<Resource, number>> {
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const [members, ringGames, running, roomCount, broadcasts] = await Promise.all([
    db.select({ n: count() }).from(memberships).where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'))),
    db.select({ n: count() }).from(clubTables).where(and(eq(clubTables.clubId, clubId), eq(clubTables.status, 'open'), eq(clubTables.kind, 'cash'))),
    db.select({ n: count() }).from(tournaments).where(and(eq(tournaments.clubId, clubId), eq(tournaments.status, 'active'))),
    db.select({ n: count() }).from(rooms).where(eq(rooms.clubId, clubId)),
    db.select({ n: count() }).from(clubMessages).where(and(
      eq(clubMessages.clubId, clubId), eq(clubMessages.status, 'sent'), ne(clubMessages.audience, 'member'),
      gte(clubMessages.sentAt, monthStart),
    )),
  ]);
  return { members: n(members), ringGames: n(ringGames), tournaments: n(running), rooms: n(roomCount), broadcasts: n(broadcasts) };
}

/** Name of the cheapest Level whose limit for `resource` is above `used`. */
async function upgradeTarget(db: DbOrTx, resource: Resource, used: number, currentCode: string, at: Date): Promise<string> {
  const offers = await levelOffers(db, at);
  const current = offers.find((o) => o.code === currentCode)?.rank ?? -1;
  const target = offers.find((o) => o.rank > current && (o.limits[resource] ?? Infinity) > used);
  return target?.name ?? nextLevel(currentCode)?.name ?? '';
}

/**
 * Capacity check other modules call before adding one more `resource`
 * (tournaments: before start; rooms: before add; broadcasts: before a promotional send).
 * `used` is the current count before the new one.
 */
export async function assertCapacity(db: DbOrTx, access: ClubAccess, resource: Resource, used: number, at: Date): Promise<void> {
  if (resource === 'broadcasts' && at < BROADCAST_QUOTA_FROM) return;
  const { code, limits } = await clubLimits(db, access.club.id, at);
  const limit = limits[resource];
  if (limit === null || limit === undefined || used < limit) return;
  const billing = can(access, 'billing');
  if (resource === 'tournaments' && limit === 0) {
    throw new AppError(billing ? 'commerce.level_tournaments_unavailable_billing' : 'commerce.level_tournaments_unavailable_staff', 409, {
      requiredLevel: await upgradeTarget(db, resource, used, code, at),
    });
  }
  const params: Record<string, string | number> = { used, limit, nextLevel: await upgradeTarget(db, resource, used, code, at) };
  if (resource === 'broadcasts') {
    params.resetDate = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();
  }
  throw new AppError(`commerce.capacity_${STEM[resource]}_${billing ? 'billing' : 'staff'}`, 409, params);
}

export type GatedAction = 'members' | 'tables' | 'broadcasts';

/**
 * Commerce gate for staff actions: a level-locked (second free) club cannot open tables or accept
 * members; a paused club cannot accept members or send promotional broadcasts.
 */
export async function assertClubOperational(db: DbOrTx, access: ClubAccess, action: GatedAction, at: Date): Promise<void> {
  const billing = can(access, 'billing');
  if (action !== 'broadcasts' && await isLevelLocked(db, access.club)) {
    throw new AppError(billing ? 'club.level_required_billing' : 'club.level_required_staff', 409);
  }
  if (action !== 'tables' && await isPaused(db, access.club.id, at)) {
    throw new AppError(billing ? 'commerce.paused_billing' : 'commerce.paused_staff', 409);
  }
}
