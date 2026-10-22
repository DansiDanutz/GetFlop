import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { ledgerEntries, memberships, pointAccounts, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { can, type ClubAccess } from '../clubs/access.js';
import { nameOf } from './shared.js';

const MINTS_SHOWN = 10;

/** Pool/stock detail for the Points screen (04 §2): who holds stock, recent mints, reserved Points. */
export async function supplyDetail(ctx: AppContext, access: ClubAccess) {
  if (!can(access, 'stock.manage')) throw new AppError('points.forbidden', 403);
  const clubId = access.club.id;
  const stocks = await ctx.db.select({ userId: users.id, username: users.username, displayName: users.displayName, stockCents: pointAccounts.balanceCents })
    .from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .leftJoin(pointAccounts, and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.kind, 'stock'), eq(pointAccounts.userId, memberships.userId)))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'), sql`'inspector' = any(${memberships.roles})`));
  const mints = await ctx.db.select({ id: ledgerEntries.id, amountCents: ledgerEntries.amountCents, note: ledgerEntries.note, createdAt: ledgerEntries.createdAt, username: users.username, displayName: users.displayName })
    .from(ledgerEntries).leftJoin(users, eq(users.id, ledgerEntries.actorId))
    .where(and(eq(ledgerEntries.clubId, clubId), eq(ledgerEntries.kind, 'mint')))
    .orderBy(desc(ledgerEntries.createdAt)).limit(MINTS_SHOWN);
  return {
    stocks: stocks.map((s) => ({ userId: s.userId, name: nameOf(s), stockCents: s.stockCents ?? 0 })).sort((a, b) => b.stockCents - a.stockCents),
    mints: mints.map((m) => ({ id: m.id, amountCents: m.amountCents, note: m.note, createdAt: m.createdAt, by: m.username ? nameOf({ username: m.username, displayName: m.displayName }) : null })),
    // Guaranteed tournament prize pools are reserved by the tournaments module (none are tracked here yet).
    reservedCents: 0,
  };
}
