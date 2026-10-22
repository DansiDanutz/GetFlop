import { and, desc, eq, gte, inArray, lt, type SQL } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { bets, clubTables, hands, users } from '../../db/schema/index.js';
import { AppError } from '../../http/errors.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { byPlayer, byRoom, byTable, ledgerByKind, POINTS_IN_KINDS, POINTS_OUT_KINDS, tournamentFigures } from './breakdowns.js';
import { csvPoints, toCsv } from './csv.js';
import { marketStats, totals } from './metrics.js';
import { displayName, settledBets, userNames } from './queries.js';
import { allTime, clubDayStart, clubTz, dateRange, OPEN_END, type Range } from './time.js';

export const HANDS_LIMIT = 200;
const MAX_REPORT_DAYS = 366;

export interface PeriodQuery {
  readonly tableId?: string;
  readonly dateStart?: string;
  readonly dateEnd?: string;
  readonly all?: boolean;
  readonly tz?: string;
}

/** all → everything; both dates → those club days; otherwise today (since 06:00 local). */
export function periodRange(access: ClubAccess, q: PeriodQuery, now: Date): Range {
  const tz = clubTz(access.club.settings, q.tz);
  if (q.all) return allTime();
  if (q.dateStart && q.dateEnd) return dateRange(q.dateStart, q.dateEnd, tz);
  if (q.dateStart || q.dateEnd) throw new AppError('report.range_invalid');
  return { from: clubDayStart(now, tz), to: OPEN_END };
}

// ── Hands (07 §4.2) ──

export async function handResults(ctx: AppContext, access: ClubAccess, q: PeriodQuery) {
  assertCan(access, 'reports');
  const range = periodRange(access, q, ctx.now());
  const conditions: SQL[] = [eq(hands.clubId, access.club.id), eq(hands.status, 'settled'),
    gte(hands.settledAt, range.from), lt(hands.settledAt, range.to)];
  if (q.tableId) conditions.push(eq(hands.tableId, q.tableId));
  const rows = await ctx.db.select({ hand: hands, tableName: clubTables.name, tableKind: clubTables.kind }).from(hands)
    .innerJoin(clubTables, eq(clubTables.id, hands.tableId)).where(and(...conditions))
    .orderBy(desc(hands.settledAt), desc(hands.handNumber)).limit(HANDS_LIMIT + 1);
  return {
    range,
    truncated: rows.length > HANDS_LIMIT,
    limit: HANDS_LIMIT,
    hands: rows.slice(0, HANDS_LIMIT).map(({ hand: h, tableName, tableKind }) => ({
      id: h.id, handNumber: h.handNumber, tableId: h.tableId, tableName, kind: tableKind === 'tournament' ? 'tournament' : 'cash',
      unit: tableKind === 'tournament' ? 'chips' : 'points', flop: h.card1 ? [h.card1, h.card2, h.card3] : null,
      bets: h.totalBets, winningBets: h.winningBets, playedCents: h.totalWageredCents, paidCents: h.totalPaidOutCents,
      holdCents: h.totalWageredCents - h.totalPaidOutCents, dealtBy: h.dealtBy, settledAt: h.settledAt,
    })),
  };
}

export type HandsResult = Awaited<ReturnType<typeof handResults>>;

export function handsCsv(result: HandsResult): string {
  const headers = ['Hand', 'Table', 'Kind', 'Card1', 'Card2', 'Card3', 'Bets', 'Winning bets', 'Played PTS', 'Won by players PTS',
    'Club result PTS', 'Played TC', 'Won by players TC', 'Date'];
  return toCsv(headers, result.hands.map((h) => {
    const cash = h.kind === 'cash';
    return [h.handNumber, h.tableName, h.kind, h.flop?.[0], h.flop?.[1], h.flop?.[2], h.bets, h.winningBets,
      cash ? csvPoints(h.playedCents) : '', cash ? csvPoints(h.paidCents) : '', cash ? csvPoints(h.holdCents) : '',
      cash ? '' : csvPoints(h.playedCents), cash ? '' : csvPoints(h.paidCents), h.settledAt ? new Date(h.settledAt).toISOString() : ''];
  }));
}

const PICK_STATUS: Record<string, 'won' | 'lost' | 'refunded' | 'open'> = {
  won: 'won', lost: 'lost', refunded: 'refunded', voided: 'refunded', pending: 'open',
};

export async function handDetail(ctx: AppContext, access: ClubAccess, handId: string) {
  assertCan(access, 'reports');
  const [row] = await ctx.db.select({ hand: hands, table: clubTables }).from(hands)
    .innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .where(and(eq(hands.id, handId), eq(hands.clubId, access.club.id))).limit(1);
  if (!row) throw new AppError('hand.not_found', 404);
  const { hand: h, table } = row;
  const list = await ctx.db.select({ bet: bets, username: users.username, displayName: users.displayName }).from(bets)
    .innerJoin(users, eq(users.id, bets.userId)).where(eq(bets.handId, h.id)).orderBy(bets.createdAt);
  const dealer = await userNames(ctx.db, [h.dealerId]);
  const byUser = new Map<string, { userId: string; name: string; playedCents: number; wonCents: number; picks: unknown[] }>();
  for (const { bet, ...u } of list) {
    const prev = byUser.get(bet.userId) ?? { userId: bet.userId, name: displayName(u), playedCents: 0, wonCents: 0, picks: [] };
    const settled = bet.status === 'won' || bet.status === 'lost';
    byUser.set(bet.userId, {
      ...prev,
      playedCents: prev.playedCents + (settled ? bet.stakeCents : 0),
      wonCents: prev.wonCents + bet.payoutCents,
      picks: [...prev.picks, {
        betId: bet.id, market: bet.market, stakeCents: bet.stakeCents, multiplier: bet.multiplierX100 / 100,
        status: PICK_STATUS[bet.status] ?? 'open', payoutCents: bet.payoutCents,
      }],
    });
  }
  const isTournament = table.kind === 'tournament';
  return {
    hand: {
      id: h.id, handNumber: h.handNumber, status: h.status, flop: h.card1 ? [h.card1, h.card2, h.card3] : null,
      matchingSlugs: h.matchingSlugs ?? [], bets: h.totalBets, winningBets: h.winningBets, playedCents: h.totalWageredCents,
      paidCents: h.totalPaidOutCents, createdAt: h.createdAt, settledAt: h.settledAt,
    },
    table: { id: table.id, name: table.name, kind: table.kind },
    dealtBy: h.dealtBy === 'auto' ? { kind: 'auto', name: null } : { kind: 'dealer', name: dealer.get(h.dealerId ?? '') ?? null },
    isTournament, unit: isTournament ? 'chips' : 'points',
    players: [...byUser.values()],
  };
}

// ── Summary "Results & Reports" (07 §4.3) ──

export async function summaryReport(ctx: AppContext, access: ClubAccess, q: PeriodQuery) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  const range = periodRange(access, q, ctx.now());
  const tableIds = q.tableId ? [q.tableId] : undefined;
  const ring = await settledBets(ctx.db, clubId, { range, unit: 'points', tableIds });
  const t = totals(ring);
  const tourn = await tournamentFigures(ctx.db, clubId, range);
  return {
    range,
    kpis: {
      hands: t.hands, playedCents: t.handleCents, paidCents: t.paidCents, resultCents: t.resultCents, holdPct: t.holdPct,
      tournaments: { entries: tourn.entries, collectedCents: tourn.collectedCents, prizesCents: tourn.prizesCents },
    },
    byRoom: await byRoom(ctx.db, clubId, ring),
    byTable: await byTable(ctx.db, clubId, ring, tableIds),
    byMarket: marketStats(ring),
    byPlayer: await byPlayer(ctx.db, clubId, ring, range),
  };
}

// ── Shift report (07 §4.5) ──

export interface ShiftQuery { readonly fromDatetime?: string; readonly toDatetime?: string; readonly tableIds?: string }

export function shiftRange(q: ShiftQuery): Range {
  if (!q.fromDatetime || !q.toDatetime) throw new AppError('report.range_invalid');
  const from = new Date(q.fromDatetime);
  const to = new Date(q.toDatetime);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new AppError('report.range_invalid');
  if (from.getTime() >= to.getTime()) throw new AppError('report.range_order');
  if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * 86_400_000) throw new AppError('report.range_invalid');
  return { from, to };
}

export async function shiftReport(ctx: AppContext, access: ClubAccess, q: ShiftQuery) {
  assertCan(access, 'reports');
  const clubId = access.club.id;
  const range = shiftRange(q);
  const tableIds = q.tableIds ? q.tableIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const ring = await settledBets(ctx.db, clubId, { range, unit: 'points', tableIds });
  const chips = await settledBets(ctx.db, clubId, { range, unit: 'chips', tableIds });
  const moves = await ledgerByKind(ctx.db, clubId, range, [...POINTS_IN_KINDS, ...POINTS_OUT_KINDS]);
  const inCents = moves.cents(...POINTS_IN_KINDS);
  const outCents = moves.cents(...POINTS_OUT_KINDS);
  const t = totals(ring);
  const trn = await tournamentFigures(ctx.db, clubId, range);
  return {
    range,
    points: { inCents, outCents, netCents: inCents - outCents },
    play: { hands: t.hands, picks: t.picks, playedCents: t.handleCents, paidCents: t.paidCents, holdCents: t.resultCents, holdPct: t.holdPct },
    tournaments: {
      entries: trn.entries, buyinsCents: trn.buyinsCents, rebuysCents: trn.rebuysCents, addonsCents: trn.addonsCents,
      prizesCents: trn.prizesCents, resultCents: trn.resultCents,
    },
    byMarket: { ring: marketStats(ring), chips: marketStats(chips) },
    byRoom: await byRoom(ctx.db, clubId, ring),
    byTable: await byTable(ctx.db, clubId, ring, tableIds),
    byPlayer: await byPlayer(ctx.db, clubId, ring, range),
  };
}

export type ShiftReport = Awaited<ReturnType<typeof shiftReport>>;

const pct = (v: number | null): string => (v === null ? '' : (v * 100).toFixed(2));

export function shiftCsv(r: ShiftReport): string {
  const rows: (string | number)[][] = [
    ['Points', 'Points in', csvPoints(r.points.inCents)], ['Points', 'Points out', csvPoints(r.points.outCents)],
    ['Points', 'Net', csvPoints(r.points.netCents)],
    ['Play', 'Hands', r.play.hands], ['Play', 'Played', csvPoints(r.play.playedCents)],
    ['Play', 'Won by players', csvPoints(r.play.paidCents)], ['Play', 'House hold', csvPoints(r.play.holdCents)],
    ['Play', 'Hold %', pct(r.play.holdPct)],
    ['Tournaments', 'Entries', r.tournaments.entries], ['Tournaments', 'Buy-ins and fees', csvPoints(r.tournaments.buyinsCents)],
    ['Tournaments', 'Rebuys', csvPoints(r.tournaments.rebuysCents)], ['Tournaments', 'Add-ons', csvPoints(r.tournaments.addonsCents)],
    ['Tournaments', 'Prizes paid', csvPoints(r.tournaments.prizesCents)], ['Tournaments', 'Result', csvPoints(r.tournaments.resultCents)],
    ...r.byMarket.ring.map((m) => ['Market', m.slug, csvPoints(m.handleCents), csvPoints(m.resultCents), pct(m.holdPct), pct(m.theoHoldPct)]),
    ...r.byTable.map((x) => ['Table', x.name, csvPoints(x.handleCents), csvPoints(x.resultCents), pct(x.holdPct)]),
    ...r.byPlayer.map((p) => ['Player', p.name, csvPoints(p.playedCents), csvPoints(p.wonCents), csvPoints(p.inCents),
      csvPoints(p.outCents), csvPoints(p.balanceCents)]),
  ];
  return toCsv(['Section', 'Item', 'Value', 'Value 2', 'Value 3', 'Value 4', 'Value 5'], rows);
}

/** Ids of every table ever in the club, archived included (pickers in reports). */
export async function reportTables(ctx: AppContext, clubId: string) {
  return ctx.db.select({ id: clubTables.id, name: clubTables.name, kind: clubTables.kind, status: clubTables.status })
    .from(clubTables).where(eq(clubTables.clubId, clubId)).orderBy(clubTables.name);
}

export async function tableNames(ctx: AppContext, ids: string[]) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await ctx.db.select({ id: clubTables.id, name: clubTables.name }).from(clubTables).where(inArray(clubTables.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
