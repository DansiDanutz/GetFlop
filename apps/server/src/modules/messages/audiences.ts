import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, ne, sum } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { coupons, memberships, messagePrefs, messageRecipients, users, type Role } from '../../db/schema/index.js';
import {
  AUDIENCE_KEYS, DAY_MS, GROUP_CAP_WINDOW_MS, TOP_ACTIVE_MIN, TOP_ACTIVE_SHARE, type AudienceKey,
} from './constants.js';
import { getTournamentSource } from './targets.js';
import { startOfMonth } from './time.js';

export const isAudienceKey = (key: unknown): key is AudienceKey =>
  typeof key === 'string' && (AUDIENCE_KEYS as readonly string[]).includes(key);

export interface AudienceScope {
  readonly clubId: string;
  readonly now: Date;
  readonly tz: string;
  /** The writer is never in their own audience. */
  readonly excludeUserId: string;
}

interface Member { readonly userId: string; readonly roles: readonly Role[]; readonly joinedAt: Date }

const STAFF_ROLES: readonly Role[] = ['manager', 'inspector', 'dealer'];

/** Active, human members of the club (bots and deleted accounts never receive messages). */
export async function activeMembers(db: DbOrTx, clubId: string, excludeUserId?: string): Promise<Member[]> {
  const rows = await db.select({
    userId: memberships.userId, roles: memberships.roles,
    reviewedAt: memberships.reviewedAt, createdAt: memberships.createdAt,
  }).from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(
      eq(memberships.clubId, clubId), eq(memberships.status, 'active'),
      eq(users.isBot, false), eq(users.isActive, true), isNull(users.deletedAt),
    ));
  return rows
    .filter((r) => r.userId !== excludeUserId)
    .map((r) => ({ userId: r.userId, roles: r.roles, joinedAt: r.reviewedAt ?? r.createdAt }));
}

type CouponKind = 'any' | 'ring' | 'tournament';

async function couponPlayers(db: DbOrTx, clubId: string, since: Date, kind: CouponKind): Promise<Set<string>> {
  const kindFilter = kind === 'ring' ? isNull(coupons.tournamentId) : kind === 'tournament' ? isNotNull(coupons.tournamentId) : undefined;
  const rows = await db.selectDistinct({ userId: coupons.userId }).from(coupons)
    .where(and(eq(coupons.clubId, clubId), ne(coupons.unit, 'stars'), gte(coupons.createdAt, since), kindFilter));
  return new Set(rows.map((r) => r.userId));
}

async function tournamentEntrants(db: DbOrTx, clubId: string, since: Date): Promise<Set<string>> {
  const source = getTournamentSource();
  return new Set(source ? await source.entrants(db, clubId, since) : []);
}

async function activeSince(db: DbOrTx, clubId: string, since: Date): Promise<Set<string>> {
  const [played, entered] = [await couponPlayers(db, clubId, since, 'any'), await tournamentEntrants(db, clubId, since)];
  return new Set([...played, ...entered]);
}

/** Top share of the last 30 days by coupons placed (then Points committed), at least TOP_ACTIVE_MIN members. */
async function topActive(db: DbOrTx, clubId: string, since: Date): Promise<Set<string>> {
  const rows = await db.select({ userId: coupons.userId, n: count(), committed: sum(coupons.committedCents) })
    .from(coupons)
    .where(and(eq(coupons.clubId, clubId), ne(coupons.unit, 'stars'), gte(coupons.createdAt, since)))
    .groupBy(coupons.userId)
    .orderBy(desc(count()), desc(sum(coupons.committedCents)));
  const size = Math.max(TOP_ACTIVE_MIN, Math.ceil(rows.length * TOP_ACTIVE_SHARE));
  return new Set(rows.slice(0, size).map((r) => r.userId));
}

async function matchSet(db: DbOrTx, key: AudienceKey, scope: AudienceScope): Promise<Set<string> | null> {
  const { clubId, now, tz } = scope;
  const daysAgo = (d: number) => new Date(now.getTime() - d * DAY_MS);
  switch (key) {
    case 'all': case 'staff': case 'new_14': case 'inactive_30': return null;
    case 'active_7': return activeSince(db, clubId, daysAgo(7));
    case 'active_30': return activeSince(db, clubId, daysAgo(30));
    case 'ring_month': return couponPlayers(db, clubId, startOfMonth(now, tz), 'ring');
    case 'tourney_month': {
      const since = startOfMonth(now, tz);
      return new Set([...await couponPlayers(db, clubId, since, 'tournament'), ...await tournamentEntrants(db, clubId, since)]);
    }
    case 'top_active': return topActive(db, clubId, daysAgo(30));
  }
}

/** Every member an audience key describes, before mute and the daily cap. */
export async function audienceMembers(db: DbOrTx, key: AudienceKey, scope: AudienceScope): Promise<string[]> {
  const members = await activeMembers(db, scope.clubId, scope.excludeUserId);
  const cutoff30 = new Date(scope.now.getTime() - 30 * DAY_MS);
  const cutoff14 = new Date(scope.now.getTime() - 14 * DAY_MS);
  if (key === 'all') return members.map((m) => m.userId);
  if (key === 'staff') return members.filter((m) => m.roles.some((r) => STAFF_ROLES.includes(r))).map((m) => m.userId);
  if (key === 'new_14') return members.filter((m) => m.joinedAt > cutoff14).map((m) => m.userId);
  if (key === 'inactive_30') {
    const active = await activeSince(db, scope.clubId, cutoff30);
    return members.filter((m) => m.joinedAt <= cutoff30 && !active.has(m.userId)).map((m) => m.userId);
  }
  const set = await matchSet(db, key, scope);
  return members.filter((m) => set?.has(m.userId)).map((m) => m.userId);
}

export interface Reach {
  readonly deliverable: readonly string[];
  readonly muted: number;
  readonly capped: number;
}

/** Removes members who muted the club, then those who already had a group message in the window. */
export async function applyDeliveryRules(db: DbOrTx, clubId: string, userIds: readonly string[], now: Date): Promise<Reach> {
  if (userIds.length === 0) return { deliverable: [], muted: 0, capped: 0 };
  const mutedRows = await db.select({ userId: messagePrefs.userId }).from(messagePrefs)
    .where(and(eq(messagePrefs.clubId, clubId), eq(messagePrefs.promoMuted, true), inArray(messagePrefs.userId, [...userIds])));
  const muted = new Set(mutedRows.map((r) => r.userId));
  const open = userIds.filter((u) => !muted.has(u));
  const cappedRows = open.length === 0 ? [] : await db.selectDistinct({ userId: messageRecipients.userId }).from(messageRecipients)
    .where(and(
      eq(messageRecipients.clubId, clubId), eq(messageRecipients.isDirect, false),
      gt(messageRecipients.deliveredAt, new Date(now.getTime() - GROUP_CAP_WINDOW_MS)),
      inArray(messageRecipients.userId, open),
    ));
  const capped = new Set(cappedRows.map((r) => r.userId));
  return { deliverable: open.filter((u) => !capped.has(u)), muted: muted.size, capped: capped.size };
}

export async function reachFor(db: DbOrTx, key: AudienceKey, scope: AudienceScope): Promise<Reach & { total: number }> {
  const members = await audienceMembers(db, key, scope);
  return { ...await applyDeliveryRules(db, scope.clubId, members, scope.now), total: members.length };
}

/** GET /messages/audiences: `{key, count, total, muted, capped}` per key, plus the one-member picker. */
export async function listAudiences(db: DbOrTx, scope: AudienceScope) {
  const audiences = [];
  for (const key of AUDIENCE_KEYS) {
    const reach = await reachFor(db, key, scope);
    audiences.push({ key, count: reach.deliverable.length, total: reach.total, muted: reach.muted, capped: reach.capped });
  }
  const memberCount = (await activeMembers(db, scope.clubId, scope.excludeUserId)).length;
  audiences.push({ key: 'member', count: memberCount, total: memberCount, muted: 0, capped: 0 });
  return audiences;
}

