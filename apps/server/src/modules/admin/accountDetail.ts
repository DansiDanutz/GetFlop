import { and, count, countDistinct, desc, eq, inArray, or } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, clubs, clubTables, hands, ledgerEntries, memberships, pointAccounts, sessions } from '../../db/schema/index.js';
import { deviceLabel } from '../auth/revocation.js';
import { adminUserView, findUser } from './accounts.js';

const MOVEMENTS_LIMIT = 200;
const PICKS_LIMIT = 100;

/** Membership status as the admin reads it. */
const MEMBERSHIP_LABEL: Record<string, string> = {
  active: 'member', pending: 'asked', left: 'left', removed: 'removed', rejected: 'not_accepted',
};

async function clubRows(ctx: AppContext, userId: string) {
  const rows = await ctx.db.select({ membership: memberships, club: clubs }).from(memberships)
    .innerJoin(clubs, eq(clubs.id, memberships.clubId)).where(eq(memberships.userId, userId)).orderBy(clubs.name);
  const handCounts = await ctx.db.select({ clubId: bets.clubId, hands: countDistinct(bets.handId) }).from(bets)
    .where(and(eq(bets.userId, userId), inArray(bets.status, ['won', 'lost']))).groupBy(bets.clubId);
  const wallets = await ctx.db.select().from(pointAccounts).where(and(eq(pointAccounts.userId, userId), eq(pointAccounts.kind, 'player')));
  return rows.map(({ membership, club }) => ({
    clubId: club.id, name: club.name, publicId: club.publicId, clubStatus: club.status,
    status: membership.status, statusLabel: MEMBERSHIP_LABEL[membership.status] ?? membership.status,
    roles: membership.roles, playMode: membership.playMode, joinedAt: membership.createdAt, lastPlayedAt: membership.lastPlayedAt,
    hands: handCounts.find((h) => h.clubId === club.id)?.hands ?? 0,
    balanceCents: wallets.find((w) => w.clubId === club.id)?.balanceCents ?? 0,
  }));
}

async function deviceRows(ctx: AppContext, userId: string) {
  const rows = await ctx.db.select({ userAgent: sessions.userAgent, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions).where(eq(sessions.userId, userId)).orderBy(desc(sessions.createdAt));
  return rows.map((r) => ({ device: deviceLabel(r.userAgent ?? undefined), signedInAt: r.createdAt, expiresAt: r.expiresAt }));
}

/** Header of the account screen: who, clubs, devices. */
export async function accountSummary(ctx: AppContext, userId: string) {
  const user = await findUser(ctx.db, userId);
  const devices = await deviceRows(ctx, userId);
  return {
    account: { ...adminUserView(user), lastSeenAt: devices[0]?.signedInAt ?? null },
    clubs: await clubRows(ctx, userId),
    devices,
  };
}

/** Wallet movements across clubs, signed from the player's side, with the balance after. */
async function movementRows(ctx: AppContext, userId: string) {
  const wallets = await ctx.db.select({ id: pointAccounts.id }).from(pointAccounts)
    .where(and(eq(pointAccounts.userId, userId), eq(pointAccounts.kind, 'player')));
  const ids = wallets.map((w) => w.id);
  if (ids.length === 0) return [];
  const rows = await ctx.db.select({ entry: ledgerEntries, clubName: clubs.name }).from(ledgerEntries)
    .innerJoin(clubs, eq(clubs.id, ledgerEntries.clubId))
    .where(or(inArray(ledgerEntries.toAccountId, ids), inArray(ledgerEntries.fromAccountId, ids)))
    .orderBy(desc(ledgerEntries.createdAt), desc(ledgerEntries.id)).limit(MOVEMENTS_LIMIT);
  return rows.map(({ entry, clubName }) => {
    const incoming = entry.toAccountId !== null && ids.includes(entry.toAccountId);
    return {
      id: entry.id, clubId: entry.clubId, clubName, kind: entry.kind,
      amountCents: incoming ? entry.amountCents : -entry.amountCents,
      balanceAfterCents: incoming ? entry.toBalanceAfter : entry.fromBalanceAfter,
      note: entry.note, refType: entry.refType, refId: entry.refId, createdAt: entry.createdAt,
    };
  });
}

async function pickRows(ctx: AppContext, userId: string) {
  const [{ total } = { total: 0 }] = await ctx.db.select({ total: count() }).from(bets).where(eq(bets.userId, userId));
  const rows = await ctx.db.select({ bet: bets, handNumber: hands.handNumber, tableName: clubTables.name, clubName: clubs.name })
    .from(bets).innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .innerJoin(clubs, eq(clubs.id, bets.clubId))
    .where(eq(bets.userId, userId)).orderBy(desc(bets.createdAt), desc(bets.id)).limit(PICKS_LIMIT);
  return {
    total,
    items: rows.map(({ bet, handNumber, tableName, clubName }) => ({
      id: bet.id, clubId: bet.clubId, clubName, tableName, handId: bet.handId, handNumber, market: bet.market,
      stakeCents: bet.stakeCents, multiplier: bet.multiplierX100 / 100, status: bet.status, payoutCents: bet.payoutCents,
      voidReason: bet.voidReason, createdAt: bet.createdAt,
    })),
  };
}

/** Full account detail: summary, movements and picks. */
export async function accountDetail(ctx: AppContext, userId: string) {
  const summary = await accountSummary(ctx, userId);
  return { ...summary, movements: await movementRows(ctx, userId), picks: await pickRows(ctx, userId) };
}
