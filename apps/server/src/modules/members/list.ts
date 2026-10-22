import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbOrTx } from '../../db/client.js';
import { memberships, pointAccounts, users, type MembershipStatus, type Role } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, highestRank, type ClubAccess } from '../clubs/access.js';
import { nameOf } from './shared.js';

export const MEMBER_FILTERS = ['all', 'players', 'staff', 'owner', 'manager', 'inspector', 'dealer', 'pending', 'ended'] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

const STATUSES_FOR: Record<'active' | 'pending' | 'ended', MembershipStatus[]> = {
  active: ['active'], pending: ['pending'], ended: ['left', 'removed'],
};

export function assertMemberViewer(access: ClubAccess): void {
  if (!can(access, 'members.review')) throw new AppError('members.forbidden', 403);
}

export interface MemberRow {
  userId: string; username: string; displayName: string; roles: Role[]; playMode: string; status: MembershipStatus;
  via: string; joinedAt: Date; lastPlayedAt: Date | null; endedAt: Date | null;
  endedBy: { userId: string; name: string } | null; reason: string | null;
  balanceCents?: number; stockCents?: number;
}

function matches(row: MemberRow, filter: MemberFilter, q: string): boolean {
  if (q && !row.username.toLowerCase().includes(q) && !row.displayName.toLowerCase().includes(q)) return false;
  if (filter === 'players') return row.roles.length === 0;
  if (filter === 'staff') return row.roles.length > 0;
  if (filter === 'owner' || filter === 'manager' || filter === 'inspector' || filter === 'dealer') return row.roles.includes(filter);
  return true;
}

const byRankThenName = (a: MemberRow, b: MemberRow): number =>
  highestRank(b.roles) - highestRank(a.roles) || a.displayName.localeCompare(b.displayName);

async function balances(db: DbOrTx, clubId: string, kind: 'player' | 'stock'): Promise<Map<string, number>> {
  const rows = await db.select({ userId: pointAccounts.userId, balance: pointAccounts.balanceCents }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.kind, kind)));
  return new Map(rows.map((r) => [r.userId ?? '', r.balance]));
}

export async function listMembers(db: DbOrTx, access: ClubAccess, filter: MemberFilter, search = '') {
  assertMemberViewer(access);
  const clubId = access.club.id;
  const reviewer = alias(users, 'reviewer');
  const rows = await db.select({ membership: memberships, user: users, reviewer: { id: reviewer.id, username: reviewer.username, displayName: reviewer.displayName } })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(reviewer, eq(reviewer.id, memberships.reviewedBy))
    .where(and(eq(memberships.clubId, clubId), inArray(memberships.status, ['active', 'pending', 'left', 'removed'])));
  const showMoney = can(access, 'members.manage');
  const [wallets, stocks] = showMoney ? await Promise.all([balances(db, clubId, 'player'), balances(db, clubId, 'stock')]) : [null, null];
  const all: MemberRow[] = rows.map(({ membership: m, user: u, reviewer: r }) => {
    const ended = m.status === 'left' || m.status === 'removed';
    const row: MemberRow = {
      userId: u.id, username: u.username, displayName: nameOf(u), roles: m.roles, playMode: m.playMode, status: m.status, via: m.via,
      joinedAt: m.status === 'active' ? m.reviewedAt ?? m.createdAt : m.createdAt, lastPlayedAt: m.lastPlayedAt,
      endedAt: ended ? m.reviewedAt : null,
      endedBy: ended && r?.id ? { userId: r.id, name: nameOf({ username: r.username ?? '', displayName: r.displayName }) } : null,
      reason: ended ? m.rejectionReason : null,
    };
    if (!wallets || !stocks) return row;
    return { ...row, balanceCents: wallets.get(u.id) ?? 0, ...(m.roles.includes('inspector') ? { stockCents: stocks.get(u.id) ?? 0 } : {}) };
  });
  const group = filter === 'pending' ? 'pending' : filter === 'ended' ? 'ended' : 'active';
  const q = search.trim().toLowerCase();
  const inGroup = (s: MembershipStatus) => STATUSES_FOR[group].includes(s);
  const members = all.filter((r) => inGroup(r.status) && matches(r, filter, q));
  const sorters = {
    active: byRankThenName,
    pending: (a: MemberRow, b: MemberRow) => a.joinedAt.getTime() - b.joinedAt.getTime(),
    ended: (a: MemberRow, b: MemberRow) => (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0),
  } as const;
  members.sort(sorters[group]);
  const counts = {
    active: all.filter((r) => r.status === 'active').length,
    pending: all.filter((r) => r.status === 'pending').length,
    ended: all.filter((r) => r.status === 'left' || r.status === 'removed').length,
  };
  return { actor: { userId: access.user.id, roles: access.roles, isAdmin: access.isAdmin }, members, counts };
}
