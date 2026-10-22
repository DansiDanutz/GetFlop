import { and, count, eq, gte, inArray, lt } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import { clubTables, coupons, hands, memberships, pointAccounts, users } from '../../db/schema/index.js';
import { assertCan, type ClubAccess } from '../clubs/access.js';
import { exposureByTable } from './dashboard.js';
import { ledgerByKind, POINTS_IN_KINDS, POINTS_OUT_KINDS, REFUND_KINDS, TOURNAMENT_COLLECT_KINDS } from './breakdowns.js';
import { csvPoints, toCsv } from './csv.js';
import { groupBy, totals } from './metrics.js';
import { settledBets } from './queries.js';
import { lastDays, type Range } from './time.js';
import { periodRange, type PeriodQuery } from './reports.js';
import { clubTz } from './time.js';

export const CLUB_REPORT_DEFAULT_DAYS = 30;
const TOP_PLAYERS = 10;

function clubReportRange(access: ClubAccess, q: PeriodQuery, now: Date): Range {
  if (q.all || q.dateStart || q.dateEnd) return periodRange(access, q, now);
  return lastDays(now, CLUB_REPORT_DEFAULT_DAYS, clubTz(access.club.settings, q.tz));
}

async function ridingNow(ctx: AppContext, clubId: string) {
  const tables = await ctx.db.select({ id: clubTables.id }).from(clubTables).where(and(eq(clubTables.clubId, clubId), eq(clubTables.kind, 'cash')));
  const exposure = await exposureByTable(ctx.db, tables.map((t) => t.id));
  return [...exposure.values()].reduce((s, x) => ({ cents: s.cents + x.exposureCents, coupons: s.coupons + x.coupons }), { cents: 0, coupons: 0 });
}

async function playerFigures(ctx: AppContext, clubId: string, range: Range) {
  const buyers = await ctx.db.selectDistinct({ userId: coupons.userId }).from(coupons).innerJoin(users, eq(users.id, coupons.userId))
    .where(and(eq(coupons.clubId, clubId), eq(coupons.unit, 'points'), eq(users.isBot, false),
      gte(coupons.createdAt, range.from), lt(coupons.createdAt, range.to)));
  const ids = buyers.map((b) => b.userId);
  const joined = ids.length === 0 ? [] : await ctx.db.select({ userId: memberships.userId, createdAt: memberships.createdAt, reviewedAt: memberships.reviewedAt })
    .from(memberships).where(and(eq(memberships.clubId, clubId), inArray(memberships.userId, ids)));
  const joinedAt = (m: { createdAt: Date; reviewedAt: Date | null }) => (m.reviewedAt ?? m.createdAt).getTime();
  const [fresh] = await ctx.db.select({ n: count() }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.clubId, clubId), eq(memberships.status, 'active'), eq(users.isBot, false),
      gte(memberships.reviewedAt, range.from), lt(memberships.reviewedAt, range.to)));
  return {
    active: ids.length,
    new: fresh?.n ?? 0,
    returning: joined.filter((m) => joinedAt(m) < range.from.getTime()).length,
  };
}

async function holdings(ctx: AppContext, clubId: string) {
  const rows = await ctx.db.select({ kind: pointAccounts.kind, balance: pointAccounts.balanceCents }).from(pointAccounts)
    .where(eq(pointAccounts.clubId, clubId));
  const of = (...kinds: string[]) => rows.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + r.balance, 0);
  return { playersHoldCents: of('player'), clubHoldsCents: of('pool', 'stock') };
}

/** GET /inspector/club-report: 30 days of Ring Game results for real players (07 §4.6). Owner or manager. */
export async function clubReport(ctx: AppContext, access: ClubAccess, q: PeriodQuery) {
  assertCan(access, 'settings');
  const clubId = access.club.id;
  const range = clubReportRange(access, q, ctx.now());
  const ring = (await settledBets(ctx.db, clubId, { range, unit: 'points' })).filter((b) => b.tableKind === 'cash');
  const t = totals(ring);
  const [flops] = await ctx.db.select({ n: count() }).from(hands).innerJoin(clubTables, eq(clubTables.id, hands.tableId))
    .where(and(eq(hands.clubId, clubId), eq(hands.status, 'settled'), eq(clubTables.kind, 'cash'),
      gte(hands.settledAt, range.from), lt(hands.settledAt, range.to)));
  const riding = await ridingNow(ctx, clubId);
  const l = await ledgerByKind(ctx.db, clubId, range, [
    'mint', ...POINTS_IN_KINDS, ...POINTS_OUT_KINDS, 'coupon_placed', 'bet_won', ...REFUND_KINDS, ...TOURNAMENT_COLLECT_KINDS, 'tournament_payout',
  ]);
  const top = [...groupBy(ring, (b) => b.userId).entries()]
    .map(([userId, list]) => ({ userId, name: list[0]!.userName, ...totals(list) }))
    .sort((a, b) => b.handleCents - a.handleCents).slice(0, TOP_PLAYERS)
    .map((p) => ({ userId: p.userId, name: p.name, picks: p.picks, playedCents: p.handleCents, resultCents: p.resultCents }));
  return {
    range,
    results: {
      flops: flops?.n ?? 0, playedCents: t.handleCents, paidCents: t.paidCents, resultCents: t.resultCents, holdPct: t.holdPct,
      ridingCents: riding.cents, ridingCoupons: riding.coupons,
    },
    players: { ...(await playerFigures(ctx, clubId, range)), top },
    points: {
      issuedCents: l.cents('mint'), sentCents: l.cents(...POINTS_IN_KINDS), returnedCents: l.cents(...POINTS_OUT_KINDS),
      intoCouponsCents: l.cents('coupon_placed'), wonCents: l.cents('bet_won'), refundedCents: l.cents(...REFUND_KINDS),
      tournamentEntriesCents: l.cents(...TOURNAMENT_COLLECT_KINDS), tournamentPrizesCents: l.cents('tournament_payout'),
      ...(await holdings(ctx, clubId)),
    },
    // 1 D per Point played; measured here, charged by the commerce module.
    diamonds: { measuredPlayD: Math.floor(t.handleCents / 100), pilot: true },
  };
}

export type ClubReport = Awaited<ReturnType<typeof clubReport>>;

export function clubReportCsv(r: ClubReport): string {
  const p = r.points;
  const rows: (string | number)[][] = [
    ['Results', 'Flops dealt', r.results.flops], ['Results', 'Points played', csvPoints(r.results.playedCents)],
    ['Results', 'Won by players', csvPoints(r.results.paidCents)], ['Results', 'Club result', csvPoints(r.results.resultCents)],
    ['Results', 'Still riding', csvPoints(r.results.ridingCents)], ['Results', 'Live coupons', r.results.ridingCoupons],
    ['Players', 'Active', r.players.active], ['Players', 'New', r.players.new], ['Players', 'Returning', r.players.returning],
    ...r.players.top.map((x) => ['Top player', x.name, csvPoints(x.playedCents), x.picks, csvPoints(x.resultCents)]),
    ['Points', 'Issued', csvPoints(p.issuedCents)], ['Points', 'Sent to players', csvPoints(p.sentCents)],
    ['Points', 'Returned by players', csvPoints(p.returnedCents)], ['Points', 'Put into coupons', csvPoints(p.intoCouponsCents)],
    ['Points', 'Won by players', csvPoints(p.wonCents)], ['Points', 'Refunded', csvPoints(p.refundedCents)],
    ['Points', 'Tournament entries', csvPoints(p.tournamentEntriesCents)], ['Points', 'Tournament prizes', csvPoints(p.tournamentPrizesCents)],
    ['Points', 'Players hold now', csvPoints(p.playersHoldCents)], ['Points', 'Club holds now', csvPoints(p.clubHoldsCents)],
    ['Diamonds', 'Play charge measured (D)', r.diamonds.measuredPlayD],
  ];
  return toCsv(['Section', 'Item', 'Value', 'Value 2', 'Value 3'], rows);
}
