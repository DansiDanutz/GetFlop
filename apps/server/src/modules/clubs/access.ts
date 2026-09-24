import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { DbOrTx } from '../../db/client.js';
import { clubs, memberships, type Role } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { AuthUser } from '../auth/session.js';

export const ROLE_RANK: Record<Role, number> = { owner: 4, manager: 3, inspector: 2, dealer: 1 };

export type Membership = typeof memberships.$inferSelect;
export type Club = typeof clubs.$inferSelect;

export function highestRank(roles: readonly Role[]): number {
  return roles.reduce((max, r) => Math.max(max, ROLE_RANK[r] ?? 0), 0);
}

/**
 * Club capabilities. Minimum rank per capability (owner 4, manager 3, inspector 2, dealer 1, player 0).
 * `play` has its own rule (staff other than the owner cannot play).
 */
export const CAPABILITY_RANK = {
  view: 0,
  deal: 1,
  floor: 2,
  'tables.edit': 2,
  'requests.review': 2,
  'members.review': 2,
  'points.send': 2,
  reports: 2,
  'limits.edit': 3,
  'members.manage': 3,
  'stock.manage': 3,
  settings: 3,
  messages: 3,
  tournaments: 2,
  'points.mint': 4,
  billing: 4,
  owner: 4,
} as const;
export type Capability = keyof typeof CAPABILITY_RANK | 'play';

export interface ClubAccess {
  readonly club: Club;
  readonly membership: Membership | null;
  readonly user: AuthUser;
  readonly rank: number;
  readonly roles: readonly Role[];
  readonly isAdmin: boolean;
}

export async function loadClubAccess(db: DbOrTx, user: AuthUser, clubId: string): Promise<ClubAccess> {
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId)).limit(1);
  if (!club || club.status === 'deleted') throw new AppError('club.not_found', 404);
  const [membership] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, user.id)))
    .limit(1);
  const active = membership?.status === 'active' ? membership : null;
  const roles = active?.roles ?? [];
  return { club, membership: active, user, rank: highestRank(roles), roles, isAdmin: user.isPlatformAdmin };
}

export function can(access: ClubAccess, capability: Capability): boolean {
  if (capability === 'play') {
    if (!access.membership || access.membership.playMode !== 'play') return false;
    // Staff (manager, inspector, dealer) do not play in their club; the owner may.
    return access.roles.includes('owner') || access.roles.length === 0;
  }
  if (access.isAdmin) return true;
  if (!access.membership) return false;
  if (capability === 'deal') return access.roles.includes('dealer');
  return access.rank >= CAPABILITY_RANK[capability];
}

export function assertCan(access: ClubAccess, capability: Capability): void {
  if (can(access, capability)) return;
  if (capability === 'play') {
    if (!access.membership) throw new AppError('club.access_denied', 403);
    if (access.membership.playMode !== 'play') throw new AppError('club.play_disabled', 403);
    throw new AppError('club.play_staff', 403);
  }
  if (!access.membership && !access.isAdmin) throw new AppError('club.access_denied', 403);
  throw new AppError('club.capability_missing', 403);
}

/** Resolves the club a request acts on: X-Club-Id header, ?clubId, or the user's active club. */
export function clubIdFrom(req: Request, user: AuthUser): string {
  const fromHeader = req.header('x-club-id');
  const fromQuery = typeof req.query.clubId === 'string' ? req.query.clubId : undefined;
  const clubId = fromHeader || fromQuery || user.activeClubId;
  if (!clubId) throw new AppError('club.context_required', 400);
  return clubId;
}

export async function requireClub(
  db: DbOrTx, req: Request, user: AuthUser, capability: Capability, clubId?: string,
): Promise<ClubAccess> {
  const access = await loadClubAccess(db, user, clubId ?? clubIdFrom(req, user));
  assertCan(access, capability);
  return access;
}
