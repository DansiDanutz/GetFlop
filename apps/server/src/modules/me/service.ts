import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import {
  bets, clubTables, clubs, coupons, hands, ledgerEntries, memberships, pointAccounts,
} from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import type { ClubAccess } from '../clubs/access.js';
import { activeMemberCount, publicClubCard } from '../clubs/service.js';
import { couponSummaries } from '../game/coupons.js';
import { LIVE_HAND } from '../game/tables.js';
import { GAME_KINDS, playerLabel, walletDelta } from './labels.js';

export const RECENT_COUPONS = 20;
export const MAX_LIVE_COUPONS = 200;
const JOIN_CODE_RE = /^[A-Z0-9]{4,16}$/;

export type GameState = 'picks_open' | 'picks_closed' | 'waiting' | 'table_closed';

type Summary = Awaited<ReturnType<typeof couponSummaries>>[number];

function gameState(tableStatus: string, handStatus: string | undefined): GameState {
  if (tableStatus !== 'open') return 'table_closed';
  if (handStatus === 'betting_open') return 'picks_open';
  if (handStatus === 'betting_closed') return 'picks_closed';
  return 'waiting';
}

const sum = (list: readonly Summary[], pick: (c: Summary) => number): number => list.reduce((s, c) => s + pick(c), 0);

/** Live coupons grouped by table, plus the latest finished ones. Player's own, active club only. */
export async function myGames(ctx: AppContext, access: ClubAccess) {
  const mine = and(eq(coupons.clubId, access.club.id), eq(coupons.userId, access.user.id));
  const liveRows = await ctx.db.select().from(coupons).where(and(mine, eq(coupons.status, 'live')))
    .orderBy(desc(coupons.createdAt)).limit(MAX_LIVE_COUPONS);
  const recentRows = await ctx.db.select().from(coupons).where(and(mine, inArray(coupons.status, ['completed', 'voided'])))
    .orderBy(desc(coupons.createdAt)).limit(RECENT_COUPONS);
  const live = await couponSummaries(ctx, liveRows);
  const recent = await couponSummaries(ctx, recentRows);

  const tableIds = [...new Set(live.map((c) => c.tableId))];
  const tables = tableIds.length === 0 ? [] : await ctx.db.select().from(clubTables).where(inArray(clubTables.id, tableIds));
  const liveHands = tableIds.length === 0 ? [] : await ctx.db.select().from(hands)
    .where(and(inArray(hands.tableId, tableIds), inArray(hands.status, [...LIVE_HAND] as ('betting_open' | 'betting_closed')[])));

  const games = tableIds.map((tableId) => {
    const table = tables.find((t) => t.id === tableId)!;
    const hand = liveHands.find((h) => h.tableId === tableId);
    const onTable = live.filter((c) => c.tableId === tableId);
    return {
      tableId, tableName: table.name, kind: table.kind, unit: onTable[0]!.unit,
      state: gameState(table.status, hand?.status), handNumber: hand?.handNumber ?? table.lastHandNumber,
      tournamentId: table.tournamentId, liveCoupons: onTable.length,
      committedCents: sum(onTable, (c) => c.committedCents),
      wonCents: sum(onTable, (c) => c.wonCents),
      stillAtStakeCents: sum(onTable, (c) => c.stillAtStakeCents),
    };
  });
  const listed = [...live, ...recent].filter((c) => c.unit === 'points');
  return {
    games, live, recent,
    totals: {
      committedCents: sum(listed, (c) => c.committedCents),
      wonCents: sum(listed, (c) => c.wonCents),
      stillAtStakeCents: sum(live.filter((c) => c.unit === 'points'), (c) => c.stillAtStakeCents),
      liveCoupons: live.length,
    },
  };
}

async function walletIdsOf(ctx: AppContext, clubId: string, userId: string): Promise<Set<string>> {
  const rows = await ctx.db.select({ id: pointAccounts.id }).from(pointAccounts)
    .where(and(eq(pointAccounts.clubId, clubId), eq(pointAccounts.kind, 'player'), eq(pointAccounts.userId, userId)));
  return new Set(rows.map((r) => r.id));
}

async function settledPicks(ctx: AppContext, clubId: string, userId: string, limit: number) {
  const rows = await ctx.db.select({ bet: bets, hand: hands, tableName: clubTables.name })
    .from(bets).innerJoin(hands, eq(hands.id, bets.handId)).innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .where(and(eq(bets.clubId, clubId), eq(bets.userId, userId), inArray(bets.status, ['won', 'lost'])))
    .orderBy(desc(hands.settledAt)).limit(limit);
  return rows.map(({ bet, hand, tableName }) => ({
    id: bet.id, couponId: bet.couponId, tableId: hand.tableId, tableName, handNumber: hand.handNumber,
    market: bet.market, stakeCents: bet.stakeCents, multiplier: bet.multiplierX100 / 100,
    status: bet.status, payoutCents: bet.payoutCents, roundNumber: bet.roundNumber,
    flop: hand.card1 ? [hand.card1, hand.card2!, hand.card3!] : null, settledAt: hand.settledAt,
  }));
}

async function walletMovements(ctx: AppContext, clubId: string, walletIds: Set<string>, limit: number) {
  if (walletIds.size === 0) return [];
  const ids = [...walletIds];
  const rows = await ctx.db.select().from(ledgerEntries)
    .where(and(eq(ledgerEntries.clubId, clubId), or(inArray(ledgerEntries.toAccountId, ids), inArray(ledgerEntries.fromAccountId, ids))))
    .orderBy(desc(ledgerEntries.createdAt)).limit(limit);
  return rows.map((r) => {
    const delta = walletDelta(r, walletIds);
    return {
      id: r.id, kind: r.kind, label: playerLabel(r.kind), amountCents: delta,
      balanceAfterCents: delta >= 0 ? r.toBalanceAfter : r.fromBalanceAfter,
      byPlayer: r.actorId === null ? false : r.actorId === r.userId,
      refType: r.refType, refId: r.refId, createdAt: r.createdAt,
    };
  });
}

async function daySummary(ctx: AppContext, clubId: string, userId: string, walletIds: Set<string>, since: Date) {
  const [placed] = await ctx.db.select({ total: sql<string>`coalesce(sum(${coupons.committedCents}), 0)` }).from(coupons)
    .where(and(eq(coupons.clubId, clubId), eq(coupons.userId, userId), eq(coupons.unit, 'points'), gte(coupons.createdAt, since)));
  const ids = [...walletIds];
  const moves = ids.length === 0 ? [] : await ctx.db.select().from(ledgerEntries).where(and(
    eq(ledgerEntries.clubId, clubId), gte(ledgerEntries.createdAt, since), inArray(ledgerEntries.kind, [...GAME_KINDS]),
    or(inArray(ledgerEntries.toAccountId, ids), inArray(ledgerEntries.fromAccountId, ids)),
  ));
  return {
    committedCents: Number(placed?.total ?? 0),
    wonCents: moves.filter((m) => m.kind === 'bet_won').reduce((s, m) => s + m.amountCents, 0),
    netTodayCents: moves.reduce((s, m) => s + walletDelta(m, walletIds), 0),
  };
}

/** History: coupons, settled picks and wallet movements, newest first. */
export async function history(ctx: AppContext, access: ClubAccess, limit: number, since: Date) {
  const clubId = access.club.id;
  const userId = access.user.id;
  const walletIds = await walletIdsOf(ctx, clubId, userId);
  const couponRows = await ctx.db.select().from(coupons).where(and(eq(coupons.clubId, clubId), eq(coupons.userId, userId)))
    .orderBy(desc(coupons.createdAt)).limit(limit);
  const list = await couponSummaries(ctx, couponRows);
  const liveRows = await ctx.db.select().from(coupons)
    .where(and(eq(coupons.clubId, clubId), eq(coupons.userId, userId), eq(coupons.status, 'live'), eq(coupons.unit, 'points')));
  const ridingCents = sum(await couponSummaries(ctx, liveRows), (c) => c.stillAtStakeCents);
  return {
    coupons: list,
    bets: await settledPicks(ctx, clubId, userId, limit),
    transactions: await walletMovements(ctx, clubId, walletIds, limit),
    summary: { ...(await daySummary(ctx, clubId, userId, walletIds, since)), ridingCents, since },
  };
}

/** Table QR lookup: the table and its club's public card; membership when signed in. */
export async function tableByCode(ctx: AppContext, rawCode: string, userId: string | null) {
  const code = rawCode.trim().toUpperCase();
  if (!JOIN_CODE_RE.test(code)) throw new AppError('table.not_found', 404);
  const [row] = await ctx.db.select({ table: clubTables, club: clubs }).from(clubTables)
    .innerJoin(clubs, eq(clubs.id, clubTables.clubId))
    .where(and(eq(clubTables.joinCode, code), eq(clubs.status, 'active'))).limit(1);
  if (!row || row.table.status === 'archived') throw new AppError('table.not_found', 404);
  const [hand] = await ctx.db.select().from(hands)
    .where(and(eq(hands.tableId, row.table.id), inArray(hands.status, ['betting_open', 'betting_closed']))).limit(1);
  let membershipStatus: string | null = null;
  if (userId) {
    const [m] = await ctx.db.select({ status: memberships.status }).from(memberships)
      .where(and(eq(memberships.clubId, row.club.id), eq(memberships.userId, userId))).limit(1);
    membershipStatus = m?.status ?? null;
  }
  const { table } = row;
  return {
    table: {
      id: table.id, name: table.name, kind: table.kind, status: table.status, game: table.game, photoUrl: table.photoUrl,
      joinCode: table.joinCode, tournamentId: table.tournamentId,
      activeHandStatus: hand?.status ?? null, activeHandNumber: hand?.handNumber ?? null,
    },
    club: publicClubCard(row.club, await activeMemberCount(ctx.db, row.club.id)),
    membershipStatus,
  };
}
