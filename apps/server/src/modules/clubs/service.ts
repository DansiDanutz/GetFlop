import { and, count, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { DbOrTx } from '../../db/client.js';
import { clubs, memberships, rooms as roomsTable, users, type Role } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { rooms } from '../../realtime/events.js';
import type { AuthUser } from '../auth/session.js';
import { assertName } from '../auth/validation.js';
import { levelOf, nextLevel } from '../commerce/levels.js';
import { account, POOL } from '../points/ledger.js';
import { ROLE_RANK, can, type ClubAccess } from './access.js';

const PUBLIC_ID_DIGITS = 7;
const MAX_ID_ATTEMPTS = 20;

export function randomPublicId(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 9_000_000;
  return String(1_000_000 + n);
}

export interface CreateClubInput {
  readonly name: string;
  readonly description?: string;
  readonly acceptClubTerms?: boolean;
}

export async function createClub(ctx: AppContext, user: AuthUser, input: CreateClubInput) {
  if (!input.acceptClubTerms) throw new AppError('club.terms_required');
  const name = assertName(input.name, { min: 3, max: 80, code: 'club.name_invalid' });
  const description = input.description?.trim() || null;
  if (description && description.length > 1_000) throw new AppError('club.description_too_long');
  return ctx.db.transaction(async (tx) => {
    let club: typeof clubs.$inferSelect | undefined;
    for (let i = 0; i < MAX_ID_ATTEMPTS && !club; i++) {
      [club] = await tx.insert(clubs)
        .values({ name, description, ownerId: user.id, publicId: randomPublicId(), termsAcceptedAt: ctx.now() })
        .onConflictDoNothing().returning();
    }
    if (!club) throw new AppError('club.create_failed', 500);
    await tx.insert(memberships).values({
      clubId: club.id, userId: user.id, roles: ['owner'], status: 'active', via: 'created',
      reviewedAt: ctx.now(), termsAcceptedAt: ctx.now(),
    });
    await tx.insert(roomsTable).values({ clubId: club.id, name: 'Main room' });
    await account(tx, club.id, POOL);
    await tx.update(users).set({ activeClubId: club.id }).where(eq(users.id, user.id));
    return club;
  });
}

export async function findByPublicId(db: DbOrTx, publicId: string) {
  if (!new RegExp(`^\\d{${PUBLIC_ID_DIGITS}}$`).test(publicId)) throw new AppError('club.id_invalid');
  const [club] = await db.select().from(clubs).where(and(eq(clubs.publicId, publicId), eq(clubs.status, 'active'))).limit(1);
  if (!club) throw new AppError('club.not_found', 404);
  return club;
}

export async function activeMemberCount(db: DbOrTx, clubId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active')));
  return row?.n ?? 0;
}

export type JoinSource = 'club_id' | 'invite' | 'qr' | 'scan';

/** Creates or re-opens a join request. Former watch-only members come back watch-only. */
export async function requestJoin(ctx: AppContext, userId: string, clubId: string, source: JoinSource) {
  const [existing] = await ctx.db.select().from(memberships)
    .where(and(eq(memberships.clubId, clubId), eq(memberships.userId, userId))).limit(1);
  if (existing?.status === 'active') throw new AppError('club.already_member', 409);
  if (existing?.status === 'pending') throw new AppError('club.request_pending', 409);
  const [row] = existing
    ? await ctx.db.update(memberships)
      .set({ status: 'pending', roles: [], via: source, reviewedAt: null, reviewedBy: null, rejectionReason: null, createdAt: ctx.now() })
      .where(eq(memberships.id, existing.id)).returning()
    : await ctx.db.insert(memberships).values({ clubId, userId, via: source, status: 'pending' }).returning();
  ctx.events.emit(rooms.staff(clubId), 'request:new', { type: 'join', membershipId: row!.id });
  return row!;
}

/** Approves or rejects a pending join request, enforcing the Level's member capacity. */
export async function reviewJoin(
  ctx: AppContext, access: ClubAccess, membershipId: string, decision: 'approve' | 'reject', reason?: string,
) {
  if (!can(access, 'members.review')) throw new AppError('club.review_denied', 403);
  const clubId = access.club.id;
  return ctx.db.transaction(async (tx) => {
    const [pending] = await tx.select().from(memberships)
      .where(and(eq(memberships.id, membershipId), eq(memberships.clubId, clubId), eq(memberships.status, 'pending')))
      .for('update').limit(1);
    if (!pending) throw new AppError('club.request_not_found', 404);
    if (decision === 'approve') {
      const level = levelOf(access.club.level);
      const used = await activeMemberCount(tx, clubId);
      if (used >= level.members) {
        const billing = can(access, 'billing');
        throw new AppError(billing ? 'commerce.capacity_members_billing' : 'commerce.capacity_members_staff', 409, {
          used, limit: level.members, nextLevel: nextLevel(level.code)?.name ?? '',
        });
      }
    }
    const [updated] = await tx.update(memberships).set({
      status: decision === 'approve' ? 'active' : 'rejected',
      reviewedBy: access.user.id, reviewedAt: ctx.now(),
      rejectionReason: decision === 'reject' ? reason ?? null : null,
    }).where(eq(memberships.id, membershipId)).returning();
    ctx.events.emit(rooms.user(pending.userId), 'club:membership-changed', {
      clubId, clubName: access.club.name, status: updated!.status,
    });
    ctx.events.emit(rooms.staff(clubId), 'request:resolved', { type: 'join', id: membershipId, byUserId: access.user.id });
    return updated!;
  });
}

export async function pendingJoinRequests(db: DbOrTx, clubId: string) {
  return db.select({
    membershipId: memberships.id, userId: users.id, username: users.username, displayName: users.displayName,
    via: memberships.via, playMode: memberships.playMode, createdAt: memberships.createdAt,
  }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'pending')))
    .orderBy(memberships.createdAt);
}

export async function myClubs(db: DbOrTx, userId: string) {
  const rows = await db.select({ club: clubs, membership: memberships }).from(memberships)
    .innerJoin(clubs, eq(clubs.id, memberships.clubId))
    .where(and(eq(memberships.userId, userId), inArray(memberships.status, ['active', 'pending']), eq(clubs.status, 'active')))
    .orderBy(clubs.name);
  const ids = rows.map((r) => r.club.id);
  const counts = ids.length === 0 ? [] : await db.select({ clubId: memberships.clubId, n: count() }).from(memberships)
    .where(and(inArray(memberships.clubId, ids), eq(memberships.status, 'active'))).groupBy(memberships.clubId);
  return rows.map(({ club, membership }) => ({
    id: club.id, publicId: club.publicId, name: club.name, description: club.description, photoUrl: club.photoUrl,
    level: club.level, membershipStatus: membership.status, roles: membership.roles, playMode: membership.playMode,
    memberCount: counts.find((c) => c.clubId === club.id)?.n ?? 0,
  }));
}

/** Staff surfaces a member can open, by role. */
export function surfacesFor(roles: readonly Role[], isAdmin: boolean): string[] {
  const rank = Math.max(0, ...roles.map((r) => ROLE_RANK[r]));
  const surfaces = ['player'];
  if (roles.includes('dealer')) surfaces.push('dealer');
  if (rank >= ROLE_RANK.inspector || isAdmin) surfaces.push('inspector');
  if (rank >= ROLE_RANK.manager || isAdmin) surfaces.push('club');
  return surfaces;
}

export const publicClubCard = (club: typeof clubs.$inferSelect, memberCount: number) => ({
  id: club.id, publicId: club.publicId, name: club.name, description: club.description, photoUrl: club.photoUrl, memberCount,
});

